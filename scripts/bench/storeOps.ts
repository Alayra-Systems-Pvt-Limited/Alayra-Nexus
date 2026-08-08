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

// How many round trips does one request make to Redis?
//
// `bench:queries` answers this for the database. It was enough while the gateway ran standalone,
// where the KV is an in-process map and a read of it costs nothing worth measuring. Against a real
// Redis every one of those reads is a network round trip, and a handful of them in sequence is
// worth more than everything the query work costs.
//
// This is the Redis counterpart, and it exists because the scaling benchmark produced a number less
// than half the standalone one and the reason had to be found rather than guessed at.
//
//   docker run -d --name nexus-ops-redis -p 56379:6379 redis:7-alpine
//   npm run build && npm run bench:store-ops
//
// Redis's own `INFO commandstats` does the counting, so nothing here has to instrument the client.

import { execFileSync, spawn } from 'node:child_process';
import { COMPLETION_BODY, setUpstream, startHarness } from './gateway';

const REDIS_CONTAINER = process.env.OPS_REDIS_CONTAINER ?? 'nexus-ops-redis';
const REDIS_PORT = parseInt(process.env.OPS_REDIS_PORT ?? '56379', 10);
const REQUESTS = parseInt(process.env.OPS_REQUESTS ?? '20', 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function redisCli(args: string[]): string {
  return execFileSync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', ...args], { encoding: 'utf8' });
}

/**
 * Collapse a monitored key to the thing it identifies.
 *
 * `nexus:setting:CACHE_ENABLED` is worth seeing in full — WHICH setting is the whole question.
 * `nexus:sticky:<64 hex chars>` is not; the hash differs per session and would turn a summary into
 * a list. So identifiers are folded and namespaces are kept.
 */
export function foldKey(key: string): string {
  return key
    .replace(/[0-9a-f]{16,}/gi, '<hash>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
}

/** A MONITOR line: `1699…  [0 127.0.0.1:1] "get" "nexus:setting:CACHE_ENABLED"` */
export function parseMonitorLine(line: string): { command: string; key: string } | null {
  const m = /\]\s+"([^"]+)"(?:\s+"([^"]*)")?/.exec(line);
  if (!m?.[1]) return null;
  return { command: m[1].toLowerCase(), key: m[2] ? foldKey(m[2]) : '' };
}

/** `cmdstat_get:calls=12,usec=…` → `{ get: 12 }` */
export function parseCommandStats(info: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of info.split(/\r?\n/)) {
    const m = /^cmdstat_([a-z|]+):calls=(\d+)/.exec(line.trim());
    if (m?.[1] && m[2]) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

async function main(): Promise<void> {
  const redisUrl = `redis://127.0.0.1:${REDIS_PORT}/0`;

  // Empty it first. Settings are cached in Redis for five minutes, and the API key hash is one of
  // them — so a second run inside that window boots against the PREVIOUS run's key hash, decides a
  // key already exists, never prints one, and fails with a confusing "could not read the generated
  // API key". The gateway is behaving correctly; the benchmark was handing it stale state.
  redisCli(['flushall']);

  // Standalone storage for the DATABASE, real Redis for the KV. Deliberate: it isolates the Redis
  // round trips from Postgres round trips, so the two costs can be told apart instead of arriving
  // as one number.
  const h = await startHarness(3210, 3401, { redisUrl });

  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    const send = (): Promise<Response> => fetch(`${h.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(COMPLETION_BODY),
    });

    // Warm up first: the caches this is meant to measure are cold on the first request, and a cold
    // read is not what a loaded gateway does.
    for (let i = 0; i < 5; i++) await (await send()).text();
    await sleep(1_500);

    redisCli(['config', 'resetstat']);

    // MONITOR alongside the counters. `INFO commandstats` says HOW MANY, which was enough to find
    // that there was a problem; it cannot say which keys, which is what decides the fix. MONITOR
    // says both, at the cost of slowing Redis — acceptable here because nothing about this script
    // is a latency measurement.
    const monitor = spawn('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'monitor']);
    const seen: string[] = [];
    monitor.stdout.on('data', (d: Buffer) => { seen.push(d.toString()); });
    await sleep(300);

    for (let i = 0; i < REQUESTS; i++) await (await send()).text();
    await sleep(1_000);
    monitor.kill();

    const stats = parseCommandStats(redisCli(['info', 'commandstats']));
    const total = Object.values(stats).reduce((a, b) => a + b, 0);

    console.log(`\n${total} Redis commands over ${REQUESTS} requests — ${(total / REQUESTS).toFixed(1)} per request\n`);
    console.log('  per req   total   command');
    for (const [cmd, n] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${(n / REQUESTS).toFixed(1).padStart(7)}  ${String(n).padStart(6)}   ${cmd}`);
    }
    const byKey = new Map<string, number>();
    for (const line of seen.join('').split(/\r?\n/)) {
      const parsed = parseMonitorLine(line);
      if (!parsed || !parsed.key) continue;
      const label = `${parsed.command} ${parsed.key}`;
      byKey.set(label, (byKey.get(label) ?? 0) + 1);
    }

    if (byKey.size > 0) {
      console.log('  per req   total   command and key');
      for (const [label, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        console.log(`  ${(n / REQUESTS).toFixed(1).padStart(7)}  ${String(n).padStart(6)}   ${label}`);
      }
    }

    console.log('');
    console.log('Each of these is a network round trip when Redis is not in this process. Sequential');
    console.log('ones cost latency that no amount of concurrency removes from a single request.');
    console.log('');
  } finally {
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
