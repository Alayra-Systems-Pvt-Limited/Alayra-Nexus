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

// A real gateway, a real upstream, both on real sockets — set up once for every benchmark.
//
// The COMPILED server (dist/), started the way `npx @alayrasystems/nexus` starts it, with a provider
// pointed at scripts/bench/mockUpstream.mjs. Nothing here is in-process and nothing is stubbed: a
// benchmark run through a mocked HTTP layer measures the mock.
//
// ── Limits are raised on purpose, and it matters ──────────────────────────────────────────────
//
// The pool key is created with rpm and tpm limits far above anything these runs generate. That is
// not cheating; it is the difference between measuring the proxy path and measuring the rate
// limiter. A benchmark that quietly spends half its requests being refused at 429 reports a
// wonderful latency figure for work the gateway declined to do. Rate limiting is worth its own
// scenario, where it is the subject rather than a contaminant.
//
// The same reasoning applies to the model prices, which are set to real-ish values here rather than
// the deliberately absurd ones the e2e suite uses to trip a budget on the first request.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/** Newest mtime under `dir`, or 0 if it does not exist. */
function newestMtime(dir: string): number {
  let newest = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Stop the run if `dist/` predates `src/`.
 *
 * Fatal rather than a warning. The whole value of these benchmarks is that a number can be trusted
 * without re-deriving where it came from, and a warning in a scrollback is not a defence against
 * publishing one that was measured from code nobody is running any more.
 */
function assertBuildIsFresh(): void {
  const built = newestMtime(join(ROOT, 'dist'));
  const source = newestMtime(join(ROOT, 'src'));
  if (built === 0) {
    throw new Error('No dist/ to measure. Run `npm run build` first — the benchmarks run the compiled server.');
  }
  if (source > built) {
    const behind = Math.round((source - built) / 1000);
    throw new Error(
      `dist/ is ${behind}s older than src/, so this run would measure code that is no longer current.\n` +
      '  Run `npm run build` and try again.',
    );
  }
}

export interface Harness {
  /** e.g. http://127.0.0.1:3401 */
  gatewayUrl: string;
  /** e.g. http://127.0.0.1:3210 */
  mockUrl: string;
  /** A Nexus API key that can call /v1/chat/completions. */
  apiKey: string;
  /** An owner session token, for /admin reads. */
  adminToken: string;
  /**
   * The credential /metrics wants, which is NOT the session token above.
   *
   * `verifyMetricsToken` compares against METRICS_TOKEN or ADMIN_PASSWORD — a scraper is not a
   * signed-in user and never holds a session. Exposed here because the difference is invisible
   * until a scrape comes back 401, and the obvious guess is the token that works everywhere else.
   */
  metricsToken: string;
  /** Set only when `profile` was requested — see scripts/bench/profileServer.cjs. */
  profileControlUrl?: string;
  /** Everything the gateway has written to stdout/stderr so far. See scripts/bench/queryCount.ts. */
  log: () => string;
  dispose: () => void;
}

export interface HarnessOptions {
  /**
   * Run the gateway as this many processes sharing the listening socket.
   *
   * Above 1 the gateway refuses to start without a real Redis, on purpose — each worker would
   * otherwise keep its own RPM/TPM counters. So this is only meaningful together with `redisUrl`.
   */
  workers?: number;
  /** Postgres, instead of the standalone SQLite file. */
  databaseUrl?: string;
  /** A real Redis, instead of the in-process map. Required for `workers` > 1. */
  redisUrl?: string;
  /**
   * What the gateway binds to. Defaults to loopback.
   *
   * A load generator running in a container cannot reach 127.0.0.1 on the host, so the k6 scenario
   * binds 0.0.0.0 and reaches it through host.docker.internal. That does expose the benchmark
   * gateway to the local network for the length of the run — it is ephemeral, its API key is
   * generated per run, and its only upstream is a mock, but it is worth knowing rather than
   * discovering.
   */
  host?: string;

  /**
   * Run the gateway under a V8 sampling profiler that can be started and stopped mid-run.
   *
   * The gateway is then the SAME code on the same port, but hosted by profileServer.cjs rather
   * than launched directly. Sampling is off until asked for, so nothing here changes a normal run
   * — but it is not free even when idle, so a profiled run's absolute numbers should never be
   * published as the gateway's latency. Profile to find WHERE the time goes; measure separately.
   */
  profile?: { controlPort: number; out: string };
}

const MASTER   = 'bench-master-password';
const EMAIL    = 'owner@bench.test';
const PASSWORD = 'a-long-enough-password-1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  const text = await r.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body: body as T };
}

async function waitFor(url: string, label: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${label} never answered ${url}`);
}

/**
 * Start the mock upstream, a standalone gateway, and wire them together.
 *
 * @param mockPort    the upstream's port
 * @param gatewayPort the gateway's port
 */
export async function startHarness(
  mockPort = 3210, gatewayPort = 3401, opts: HarnessOptions = {},
): Promise<Harness> {
  const children: ChildProcess[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'nexus-bench-'));

  const dispose = (): void => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the file */ }
  };

  try {
    const mockUrl = `http://127.0.0.1:${mockPort}`;
    children.push(spawn(process.execPath, [join(ROOT, 'scripts', 'bench', 'mockUpstream.mjs')], {
      env: { ...process.env, PORT: String(mockPort) }, stdio: 'ignore',
    }));
    await waitFor(`${mockUrl}/health`, 'mock upstream');

    // Deleted rather than blanked, so the gateway has to pin its own storage the way it does under
    // npx. A developer's .env would otherwise make this benchmark quietly measure PostgreSQL while
    // reporting standalone — the exact confusion scripts/smoke/standalone.ts documents at length.
    const env = {
      ...process.env,
      NEXUS_MODE: '',
      PORT: String(gatewayPort),
      HOST: opts.host ?? '127.0.0.1',
      NODE_ENV: 'production',
      ADMIN_PASSWORD: MASTER,
      MASTER_ENCRYPTION_KEY: 'b'.repeat(64),
      LOG_LEVEL: 'error',
      // The mock upstream is on loopback, and the SSRF guard blocks private hosts by default —
      // correctly, since that is the whole point of it. Named exactly, rather than reached for with
      // SSRF_ALLOW_PRIVATE=true: the guard stays fully armed for every other address, so the check
      // remains on the measured path instead of being switched off for the convenience of the
      // benchmark. Its cost is then part of what these numbers report, which is honest.
      SSRF_ALLOWLIST: `127.0.0.1:${mockPort}`,
      // The generated API key is written here rather than printed, so this is where the harness
      // collects it. Pinned to the run's own temp directory so a benchmark never reads — or worse,
      // overwrites — the key of a real gateway on the same machine.
      NEXUS_DATA_DIR: dir,
    } as NodeJS.ProcessEnv;
    // Deleted unless the caller pins them. A developer's .env would otherwise make a run that
    // reports "standalone" quietly measure their PostgreSQL.
    if (opts.databaseUrl) env.DATABASE_URL = opts.databaseUrl; else delete env.DATABASE_URL;
    if (opts.redisUrl)    env.REDIS_URL    = opts.redisUrl;    else delete env.REDIS_URL;
    if (opts.workers && opts.workers > 1) env.NEXUS_CLUSTER_WORKERS = String(opts.workers);

    // Refuse to measure a build that is older than the source it came from.
    //
    // This is not hypothetical. A benchmark run against a stale dist/ reported the exact behaviour
    // a change had just removed — the numbers were real, they simply belonged to the previous
    // version of the code, and nothing in the output said so. A measurement that is confidently
    // wrong is worse than no measurement, and this one would have been published.
    assertBuildIsFresh();

    // Either the compiled server directly, or the same server hosted inside the profiler wrapper.
    // The wrapper `require`s dist/server.js in its own isolate, so the gateway being measured is
    // byte-identical either way — only the process that owns it differs.
    let entry = join(ROOT, 'dist', 'server.js');
    if (opts.profile) {
      entry = join(ROOT, 'scripts', 'bench', 'profileServer.cjs');
      env.PROFILE_CONTROL_PORT = String(opts.profile.controlPort);
      env.PROFILE_OUT = opts.profile.out;
    }

    let out = '';
    const gw = spawn(process.execPath, [entry], {
      cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(gw);
    gw.stdout?.on('data', (d) => { out += d; });
    gw.stderr?.on('data', (d) => { out += d; });

    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const profileControlUrl = opts.profile ? `http://127.0.0.1:${opts.profile.controlPort}` : undefined;
    await waitFor(`${gatewayUrl}/health`, 'gateway');
    if (profileControlUrl) await waitFor(`${profileControlUrl}/health`, 'profiler control');

    // Written once, on the first run, and never recoverable afterwards — so it is read from the file
    // the gateway put it in rather than requested.
    const apiKey = readGeneratedApiKey(dir);

    const adminToken = await provisionGateway(gatewayUrl, mockUrl);

    return { gatewayUrl, mockUrl, apiKey, adminToken, metricsToken: MASTER, profileControlUrl, log: () => out, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** Tell the upstream how to behave for the next phase. See mockUpstream.mjs. */
export async function setUpstream(
  mockUrl: string, behaviour: { latencyMs?: number; status?: number; failRate?: number; rate429?: number },
): Promise<void> {
  await fetch(`${mockUrl}/__behaviour`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(behaviour),
  });
}

/**
 * A body whose content — and so whose sticky session — is unique to `n`.
 *
 * The gateway pins a conversation to the key that last served it, keyed by a hash of the message
 * content (src/lib/sticky.ts). An identical body therefore pins every request to the SAME key and
 * takes `tryStickyKey`, one indexed lookup — while the routing sweep that real traffic exercises
 * never runs at all. Every measurement in this repository had that blind spot until it was found by
 * being asked why the benchmark used a single pool.
 *
 * Pass an incrementing `n` to force a sticky miss on every request and measure the sweep instead.
 */
export const completionBody = (n?: number): Record<string, unknown> => ({
  model: 'alayra-nexus-1',
  messages: [{ role: 'user', content: n === undefined ? 'Benchmark request.' : `Benchmark request. n=${n}` }],
});

/** The body every scenario sends, so they are all measuring the same request. */
export const COMPLETION_BODY = completionBody();

/**
 * Claim a fresh gateway and give it one pool, one key and one model.
 *
 * Exported because the k6 rig runs the gateway in a CONTAINER rather than as a child process, and
 * has to do the same setup against it. Keeping one copy is what stops the two scenarios drifting
 * into measuring subtly different configurations — the sort of difference that only ever shows up
 * as an unexplained gap between two numbers.
 *
 * @param gatewayUrl a URL the CALLER can reach (for a container, its published host port)
 * @param mockUrl    a URL the GATEWAY can reach, which is not always the same one
 */
export async function provisionGateway(gatewayUrl: string, mockUrl: string): Promise<string> {
  const post = (path: string, body: unknown, token?: string) => json<Record<string, never>>(
    `${gatewayUrl}${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
  );

  await post('/admin/setup/claim', { masterPassword: MASTER, name: 'Bench Owner', email: EMAIL, password: PASSWORD });
  const login = await json<{ token: string }>(`${gatewayUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const adminToken = login.body.token;
  if (!adminToken) throw new Error(`sign-in failed: ${JSON.stringify(login.body).slice(0, 300)}`);

  const pool = await json<{ provider: { id: string } }>(`${gatewayUrl}/admin/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: 'Bench Pool', slug: 'bench', provider: 'custom', tier: 'standard',
      baseUrl: `${mockUrl}/v1`, authHeader: 'Authorization', authPrefix: 'Bearer ',
    }),
  });
  const poolId = pool.body.provider?.id;
  if (!poolId) throw new Error(`provider creation failed: ${JSON.stringify(pool.body).slice(0, 300)}`);

  // See the header: high enough that nothing here is ever refused for rate.
  await post(`/admin/providers/${poolId}/keys`, {
    apiKey: 'sk-bench-upstream', label: 'bench key', rpmLimit: 100_000_000, tpmLimit: 100_000_000,
  }, adminToken);

  await json(`${gatewayUrl}/admin/models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      models: [{
        id: 'bench-model-1', displayName: 'Bench Model', provider: 'custom', modelString: 'bench-model-1',
        tier: 'standard', status: 'active', priority: 1, capabilities: ['chat'],
        // Plausible rather than absurd, so `estimatedUsd` and `savedUsd` mean something when the
        // cache scenario reads them back.
        inputCostPer1M: 3, outputCostPer1M: 15,
      }],
    }),
  });

  return adminToken;
}

/**
 * The API key the gateway writes exactly once, on its first boot.
 *
 * It used to be scraped out of the log, which is exactly the habit the gateway stopped supporting —
 * a credential on stdout is a credential in whatever collects stdout. It is written to a 0600 file
 * in the data directory instead, and `startHarness` points that at the run's own temp directory.
 */
export const API_KEY_FILE = 'api-key.txt';

export function readGeneratedApiKey(dataDir: string): string {
  const path = join(dataDir, API_KEY_FILE);
  let key: string;
  try {
    key = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`could not read the generated API key from ${path}`, { cause: err });
  }
  if (!key) throw new Error(`the API key file at ${path} is empty`);
  return key;
}

/**
 * The same key, when the gateway is in a CONTAINER and the file is on its filesystem rather than
 * this one. `readKeyFile` is passed in so this stays testable and so the caller keeps ownership of
 * how it talks to Docker — `docker exec` in the rig, `docker compose exec` in provision.
 */
export function readContainerApiKey(readKeyFile: () => string): string {
  const key = readKeyFile().trim();
  if (!key) {
    throw new Error(
      'the gateway container has no API key file yet. It is written on first boot to ' +
      `NEXUS_DATA_DIR/${API_KEY_FILE}; check the container reached that point.`,
    );
  }
  return key;
}
