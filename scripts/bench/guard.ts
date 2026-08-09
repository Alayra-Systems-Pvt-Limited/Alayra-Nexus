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

// The findings that must not quietly come back. Run as a CI gate.
//
//   npm run build && npm run bench:guard                        (standalone: SQLite + in-process KV)
//   GUARD_REDIS_URL=redis://127.0.0.1:56379 npm run bench:guard (against the production key store)
//
// ── Why a gate rather than another benchmark ──────────────────────────────────────────────────
//
// Two defects were found by measurement, fixed, and would come back unnoticed:
//
//   the response cache serving nothing        — the whole feature, silently inert
//   a database query per pool the router walks — 1.2 queries/request down to 0.15
//
// Both pass typecheck, lint and the entire unit suite in their broken form. Both were found by
// running the gateway and counting, and only counting will find them again. Each limit below was
// verified by breaking the fix and watching this script fail — a guard nobody has seen fail is a
// guard nobody knows works.
//
// A third finding — PR #78's round-trip reduction — is deliberately NOT guarded here. See the note
// further down for why, and why faking it green would have been worse than leaving it out.
//
// ── What it asserts, and what it deliberately does not ────────────────────────────────────────
//
// Counts and correctness. Never latency. That is not caution, it is this repository's own rule,
// written into the e2e job in ci.yml: shared-runner timings are noise, a flaky gate gets ignored,
// and an ignored gate is worse than none. A count is the same number on a laptop and on a loaded
// CI runner; a p50 is not.
//
// ── Thresholds are ceilings, not targets ──────────────────────────────────────────────────────
//
// Each limit sits above the measured value with room for ordinary variation, and BELOW the value
// the defect produced. A guard that trips on noise gets disabled within a week; a guard set so
// loosely that the old bug fits under it protects nothing. Both numbers are recorded next to every
// limit so the next person can see the gap they are working with rather than guess at it.

import Redis from 'ioredis';
import { completionBody, setUpstream, startHarness, type Harness } from './gateway';

const REQUESTS = parseInt(process.env.GUARD_REQUESTS ?? '20', 10);
const REDIS_URL = process.env.GUARD_REDIS_URL ?? '';

/** Prisma writes `prisma:query <SQL>` to stdout when the client is built with log: ['query']. */
const QUERY_LINE = /^prisma:query\s+(.*)$/;

const sleep = (msec: number): Promise<void> => new Promise((r) => setTimeout(r, msec));

interface Check {
  name: string;
  /** What this run measured, already divided per request where that is the unit. */
  measured: number | null;
  limit: number;
  unit: string;
  /** What the defect this guards against produced, for the record. */
  wasBefore: string;
  skipped?: string;
  /** A second reason to fail, independent of the number. Printed as the diagnosis. */
  problem?: string;
}

function verdict(c: Check): 'PASS' | 'FAIL' | 'SKIP' {
  if (c.skipped) return 'SKIP';
  if (c.problem) return 'FAIL';
  return c.measured !== null && c.measured <= c.limit ? 'PASS' : 'FAIL';
}

// ── The checks ────────────────────────────────────────────────────────────────────────────────

/**
 * Does the response cache still serve?
 *
 * Binary and infra-free, and the single most valuable line here. The cache is the gateway's
 * headline cost-saving feature; it can stop serving without one test failing, and the failure is
 * invisible from inside — a gateway whose cache writes and reads correctly but never replays looks
 * entirely healthy. Counted at the upstream for that reason.
 */
async function checkCacheServes(h: Harness): Promise<Check> {
  const send = (n: number) => fetch(`${h.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(completionBody(n)),
  });

  await fetch(`${h.gatewayUrl}/admin/settings/cache`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    body: JSON.stringify({ enabled: true, ttlSeconds: 3600 }),
  });
  await fetch(`${h.mockUrl}/__reset`, { method: 'POST' });

  const ROUNDS = 5;
  let stamped = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const r = await send(7777);
    await r.text();
    if (r.headers.get('x-nexus-cache') === 'hit') stamped++;
  }

  const { requests } = await (await fetch(`${h.mockUrl}/__stats`)).json() as { requests: number };

  // Two independent witnesses, reported separately on purpose. The provider's counter is the one
  // that cannot be wrong in our favour, so it is the number; the header is what a caller sees, and
  // the two disagreeing is its own kind of bug — a response stamped "hit" that the provider
  // actually served is worse than no cache at all. Collapsing them into one value would have hidden
  // the provider count behind the word "mismatch" at exactly the moment it was needed.
  const expectedHits = ROUNDS - 1;
  return {
    name:      'the response cache serves',
    measured:  requests,
    limit:     1,
    unit:      `provider calls for ${ROUNDS} identical requests`,
    wasBefore: 'doubted from real use; unmeasured until PR #81',
    problem:   stamped === expectedHits ? undefined
      : `the header stamped ${stamped} hits where ${expectedHits} were expected — `
        + `the provider counter and X-Nexus-Cache disagree about what happened`,
  };
}

/**
 * Database queries per request, on the routing sweep.
 *
 * Unique message content forces a sticky MISS, which is what makes the router walk its pools —
 * the path that used to cost a `SELECT NexusKey` per pool. An identical body would pin every
 * request to one key and take a single indexed lookup, which is exactly the blind spot that hid
 * this cost from every benchmark in the repository until PR #77.
 */
async function checkQueriesPerRequest(h: Harness): Promise<Check> {
  await fetch(`${h.gatewayUrl}/admin/settings/cache`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    body: JSON.stringify({ enabled: false, ttlSeconds: 3600 }),
  });

  let n = 0;
  const send = (): Promise<Response> => fetch(`${h.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(completionBody(n++)),
  });

  // The first requests pay one-time work — lazy config reads, a cold key cache — that is genuinely
  // not per-request. Counting it would overstate the steady state and make the limit meaningless.
  for (let i = 0; i < 5; i++) await (await send()).text();
  await sleep(1_500);

  const mark = h.log().length;
  for (let i = 0; i < REQUESTS; i++) await (await send()).text();
  // Usage writes are fire-and-forget. Without this they land after the window and the count reads
  // low — a guard that passes because it looked too early is worse than no guard.
  await sleep(2_000);

  const queries = h.log().slice(mark).split(/\r?\n/)
    .filter((line) => QUERY_LINE.test(line.trim())).length;

  if (queries === 0) {
    return {
      name: 'database queries per request', measured: null, limit: 0, unit: '',
      wasBefore: '', skipped: 'no prisma:query lines — PRISMA_LOG_QUERIES did not reach the child',
    };
  }

  return {
    name:      'database queries per request',
    measured:  queries / REQUESTS,
    limit:     parseFloat(process.env.GUARD_MAX_QUERIES ?? '0.8'),
    unit:      'queries/request on a sticky miss',
    wasBefore: '1.2–1.3 before PR #77',
  };
}

// ── Why there is no Redis round-trip check here, deliberately ─────────────────────────────────
//
// PR #78's win — up to 5.3x fewer round trips on an exhausted pool — is the most valuable finding
// of the three and is the one NOT guarded below. Two attempts were discarded rather than shipped
// green, because a check that cannot detect the regression it names is worse than an absent one:
// it reports coverage that does not exist.
//
//   `INFO commandstats` counts every command Redis EXECUTES, INCLUDING the calls a Lua script makes
//   internally. That is the distinction this repository already got wrong once and had to correct
//   publicly. It defeats the check outright here: after the fix ONE `EVAL` performs about eight
//   internal operations, so executed commands stay level or RISE while round trips fall by five
//   times. Reverting the fix would barely move the number, and could lower it.
//
//   Counting true round trips (MONITOR, filtering the `lua` origin) measures the right thing, but
//   not against this harness. The gateway here has one pool with one key, and the changelog's own
//   figures for that shape are 7.1 before and 6.1 after — a gap too small to separate from ordinary
//   variation. The 23.7-to-4.5 result needs a pool with ten keys, deliberately exhausted so the
//   router has to walk all of them, which is the rig `bench:routing` builds.
//
// So this belongs with that rig, not with this one, and it is filed rather than faked. The Redis
// service is still used below: it makes the cache check exercise the production key-value store
// rather than the in-process stand-in, which is worth having on its own.

// ── Runner ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.PRISMA_LOG_QUERIES = '1'; // before the harness copies process.env into the child

  if (REDIS_URL) {
    // Settings live in Redis for five minutes and the API key's hash is one of them. A second run
    // inside that window boots against the previous run's hash and never writes a key. See
    // storeOps.ts, which hit this first.
    const c = new Redis(REDIS_URL);
    await c.flushall();
    c.disconnect();
  }

  const h = await startHarness(3210, 3401, REDIS_URL ? { redisUrl: REDIS_URL } : {});
  const checks: Check[] = [];

  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    // Order matters: the query check runs with the cache OFF so it measures the routing path, and
    // the cache check turns it on. Running the cache check first would leave it enabled.
    checks.push(await checkQueriesPerRequest(h));
    checks.push(await checkCacheServes(h));
  } finally {
    h.dispose();
  }

  console.log('');
  console.log(`  ${'check'.padEnd(30)}${'measured'.padStart(10)}${'limit'.padStart(9)}   verdict`);
  for (const c of checks) {
    const shown = c.measured === null ? '—' : c.measured.toFixed(2);
    console.log(
      `  ${c.name.padEnd(30)}${shown.padStart(10)}${(c.skipped ? '—' : c.limit.toFixed(2)).padStart(9)}   ${verdict(c)}`,
    );
  }

  console.log('');
  for (const c of checks) {
    if (c.skipped) console.log(`  SKIPPED  ${c.name} — ${c.skipped}`);
    else console.log(`  ${c.name}: ${c.unit}. Was ${c.wasBefore}.`);
    if (c.problem) console.log(`           ↳ ${c.problem}`);
  }

  // A skipped check must be as loud as a failing one. `npm test` silently skipping the parity
  // suites without Docker has already cost this project a wrong "all green" once, and a gate that
  // reports success while asserting nothing is the same mistake with higher stakes.
  const skipped = checks.filter((c) => c.skipped);
  const failed  = checks.filter((c) => verdict(c) === 'FAIL');

  console.log('');
  if (skipped.length > 0) {
    console.log(`  ⚠ ${skipped.length} of ${checks.length} checks did NOT run. This gate is only as`);
    console.log('    strong as the checks that executed — do not read a pass as full coverage.');
  }
  if (failed.length > 0) {
    console.log(`  ✗ ${failed.length} check(s) failed. A number that was measured and fixed has moved back.`);
    console.log('    Re-run the benchmark it came from before assuming the limit is wrong:');
    console.log('    bench:queries (PR #77) · bench:store-ops (PR #78) · bench:cache (PR #81).');
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${checks.length - skipped.length} of ${checks.length} checks passed.`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
