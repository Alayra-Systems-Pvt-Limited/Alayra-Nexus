/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// Everything in containers on one network: gateway, mock upstream, Postgres, Redis — and the load
// generator alongside them.
//
// ── Why this exists, and what it replaces ─────────────────────────────────────────────────────
//
// The first attempt ran k6 in a container against a gateway on the host, reached through
// `host.docker.internal`. The numbers were nonsense, and usefully so:
//
//   200 rps requested → p95 88 ms, where the same gateway measured 17 ms from a host-side driver
//   400 rps and above → dropped iterations, then `connection refused` from 192.168.65.254
//
// That address is Docker Desktop's NAT. Every request was crossing a userspace proxy between the
// Windows host and the Linux VM, and the measurement was of that proxy. `--network host` does not
// help either: on Docker Desktop it joins the VM's namespace, not the host's, so the container
// cannot see the gateway at all. Verified both ways before rewriting.
//
// Putting everything on one bridge network removes the crossing entirely. It is also what a
// published benchmark should look like — a reader runs the same images, not "install Node, build,
// then run this against a server you started yourself".
//
// ── The two URLs, which are not interchangeable ───────────────────────────────────────────────
//
// The gateway is reachable two ways and they are for different things:
//
//   internalUrl  http://nexus-bench-gw:3000   what the LOAD GENERATOR uses. No NAT, and the only
//                                             address whose numbers mean anything.
//   hostUrl      http://127.0.0.1:3401        what THIS process uses to claim the gateway and
//                                             configure it. Setup is a handful of requests and its
//                                             latency is not measured, so the NAT is harmless here.
//
// Using hostUrl for load is the mistake this file was written to stop, so it is spelled out rather
// than left to be inferred from a variable name.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { provisionGateway, readGeneratedApiKey } from './gateway';

const ROOT = resolve(__dirname, '..', '..');

export const NETWORK = 'nexus-bench-net';
export const GW_CONTAINER = 'nexus-bench-gw';
export const MOCK_CONTAINER = 'nexus-bench-mock';
const PG_CONTAINER = 'nexus-bench-pg';
const REDIS_CONTAINER = 'nexus-bench-redis';

const GW_IMAGE = process.env.BENCH_GATEWAY_IMAGE ?? 'nexus-bench:local';
const MOCK_IMAGE = 'nexus-bench-mock:local';

/** Published to the host only for setup and for steering the mock. Never used for load. */
const GW_HOST_PORT = 3401;
const MOCK_HOST_PORT = 3210;

const PG_PASSWORD = 'benchpass';
const MASTER = 'bench-master-password';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function docker(args: string[], quiet = true): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 64 * 1024 * 1024 }) ?? '';
  } catch (e) {
    if (quiet) return '';
    throw e;
  }
}

export interface Rig {
  /** For the load generator, on the container network. The only address worth measuring. */
  internalUrl: string;
  /** For this process: setup and control. Crosses the host NAT, which is fine for a few requests. */
  hostUrl: string;
  /** What the MOCK is called on the container network — the gateway's upstream. */
  mockInternalUrl: string;
  /** For steering the mock's behaviour from here. */
  mockHostUrl: string;
  apiKey: string;
  dispose: () => void;
}

function buildImages(): void {
  // The mock upstream as its own image rather than a bind mount: Docker Desktop only shares drives
  // an operator has explicitly enabled, and a benchmark that fails on a machine where F: is not
  // shared is not a reproducible benchmark.
  console.log('building the mock upstream image…');
  execFileSync('docker', ['build', '-t', MOCK_IMAGE, '-f', '-', '.'], {
    cwd: ROOT,
    input: [
      'FROM node:22-alpine',
      'COPY scripts/bench/mockUpstream.mjs /mock.mjs',
      'ENV PORT=3210',
      // 0.0.0.0, not the loopback default: see the note in mockUpstream.mjs. A container that
      // binds 127.0.0.1 is reachable from nothing but itself.
      'ENV HOST=0.0.0.0',
      'EXPOSE 3210',
      'CMD ["node", "/mock.mjs"]',
    ].join('\n'),
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (process.env.BENCH_GATEWAY_IMAGE) {
    console.log(`using prebuilt gateway image ${GW_IMAGE}`);
    return;
  }
  console.log('building the gateway image (this is the real Dockerfile, so it takes a few minutes)…');
  execFileSync('docker', ['build', '-t', GW_IMAGE, '.'], { cwd: ROOT, stdio: 'inherit' });
}

export function rigDown(): void {
  docker(['rm', '-f', GW_CONTAINER, MOCK_CONTAINER, PG_CONTAINER, REDIS_CONTAINER]);
  docker(['network', 'rm', NETWORK]);
}

async function waitForHttp(url: string, label: string, seconds = 120): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} never answered ${url}\n${docker(['logs', '--tail', '40', GW_CONTAINER])}`);
}

export async function startRig(opts: { workers?: number } = {}): Promise<Rig> {
  const workers = opts.workers ?? 1;

  rigDown();
  buildImages();

  docker(['network', 'create', NETWORK], false);

  docker(['run', '-d', '--name', PG_CONTAINER, '--network', NETWORK,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    // tmpfs: the benchmark writes almost nothing and none of it needs to outlive the run, so the
    // host disk stays out of the measurement.
    '--tmpfs', '/var/lib/postgresql/data',
    'postgres:16-alpine',
  ], false);

  docker(['run', '-d', '--name', REDIS_CONTAINER, '--network', NETWORK, 'redis:7-alpine'], false);

  docker(['run', '-d', '--name', MOCK_CONTAINER, '--network', NETWORK,
    '-p', `${MOCK_HOST_PORT}:3210`, MOCK_IMAGE,
  ], false);

  for (let i = 0; i < 120; i++) {
    if (docker(['exec', PG_CONTAINER, 'pg_isready', '-U', 'postgres']).includes('accepting connections')) break;
    await sleep(500);
  }
  docker(['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-c', 'CREATE DATABASE nexus']);

  const env = [
    '-e', `DATABASE_URL=postgresql://postgres:${PG_PASSWORD}@${PG_CONTAINER}:5432/nexus`,
    '-e', `REDIS_URL=redis://${REDIS_CONTAINER}:6379`,
    '-e', `ADMIN_PASSWORD=${MASTER}`,
    '-e', `MASTER_ENCRYPTION_KEY=${'b'.repeat(64)}`,
    '-e', 'LOG_LEVEL=error',
    '-e', 'NODE_ENV=production',
    // The server-level abuse guard, raised for the same reason the pool key's RPM/TPM limits are:
    // it is a DIFFERENT limiter from those, and leaving it at its default quietly caps this rig at
    // 12,000 requests a minute — 200 a second. A sweep past that measured the limiter instead of
    // the gateway and looked like a catastrophe: 100% failures at a 1 ms p50, which is exactly what
    // a 429 looks like. Rate limiting deserves its own scenario, where it is the subject.
    '-e', 'ABUSE_RATE_LIMIT_MAX=100000000',
    // The upstream is a private address on the container network, and the SSRF guard blocks those
    // by default — correctly. Named exactly rather than switched off with SSRF_ALLOW_PRIVATE, so
    // the guard stays armed for everything else and its cost stays inside the numbers.
    '-e', `SSRF_ALLOWLIST=${MOCK_CONTAINER}:3210`,
  ];
  if (workers > 1) env.push('-e', `NEXUS_CLUSTER_WORKERS=${workers}`);

  docker(['run', '-d', '--name', GW_CONTAINER, '--network', NETWORK,
    '-p', `${GW_HOST_PORT}:3000`, ...env, GW_IMAGE,
  ], false);

  const hostUrl = `http://127.0.0.1:${GW_HOST_PORT}`;
  await waitForHttp(`${hostUrl}/health`, 'gateway');

  const apiKey = readGeneratedApiKey(docker(['logs', GW_CONTAINER]));
  const mockInternalUrl = `http://${MOCK_CONTAINER}:3210`;
  await provisionGateway(hostUrl, mockInternalUrl);

  return {
    internalUrl: `http://${GW_CONTAINER}:3000`,
    hostUrl,
    mockInternalUrl,
    mockHostUrl: `http://127.0.0.1:${MOCK_HOST_PORT}`,
    apiKey,
    dispose: rigDown,
  };
}
