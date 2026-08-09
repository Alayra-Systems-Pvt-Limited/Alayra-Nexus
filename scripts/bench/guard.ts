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
// Three defects were found by measurement, fixed, and would come back unnoticed:
//
//   the response cache serving nothing         — the whole feature, silently inert
//   a database query per pool the router walks  — 1.2 queries/request down to 0.15
//   three Redis round trips per candidate key   — up to 5.3x fewer hops on an exhausted pool
//
// All three pass typecheck, lint and the entire unit suite in their broken form. All three were
// found by running the gateway and counting, and only counting will find them again. Each limit
// below was verified by breaking the fix and watching this script fail — a guard nobody has seen
// fail is a guard nobody knows works.
//
// Every check reports SKIP rather than PASS when it cannot actually measure. A gate that reports
// success while asserting nothing is the failure mode with the highest cost, because it is the one
// nobody investigates.
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

/** Keys in the one pool the walk check builds, and the rpm each is clamped to. */
const WALK_KEYS = parseInt(process.env.GUARD_WALK_KEYS ?? '10', 10);
const WALK_RPM  = parseInt(process.env.GUARD_WALK_RPM ?? '5', 10);

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

/**
 * Does the router still walk an exhausted pool in ONE call?
 *
 * This is PR #78's win, and it took three attempts to guard it in a way that could actually detect
 * its loss. The two rejected ones are recorded because both look correct:
 *
 *   `INFO commandstats` counts every command Redis EXECUTES, INCLUDING the calls a Lua script makes
 *   internally — the distinction this repository already got wrong once and corrected publicly. It
 *   defeats the check outright: after the fix ONE `EVAL` performs about eight internal operations,
 *   so executed commands stay level or RISE while round trips fall fivefold. Reverting the fix would
 *   barely move the number and could lower it.
 *
 *   An ABSOLUTE round-trip limit measures the right thing but needs a number that travels. Round
 *   trips per request depend on how many pools and keys exist, so any constant is a fact about this
 *   harness rather than about the gateway, and it would have to be re-tuned by whoever next changes
 *   the fixture.
 *
 * What is asserted instead is a RATIO: the cost of a request that walks past every exhausted key,
 * over the cost of one served immediately. That is the shape of the defect rather than its size —
 * the old code paid three round trips per candidate, so walking ten keys cost ten times what one
 * did; the new code pays them inside a single script, so walking deeper costs Redis CPU and no
 * further hops. A ratio also cancels the machine, the fixture size and the Redis version.
 *
 *   before PR #78   7.1 -> 23.7 round trips per request, a ratio of 3.34
 *   after           6.1 ->  4.5, a ratio of 0.74 — deeper is not more expensive
 *
 * ── Where the limit came from, because the first one was useless ──────────────────────────────
 *
 * It was set to 2.0 on the reasoning above, and the mutation test then PASSED: reverting the fix to
 * one call per candidate moved the ratio to 1.67, comfortably under the limit. A guard that a
 * regression walks straight through is the thing this file exists to not be, and it was only caught
 * because breaking the fix is a required step rather than an optional one.
 *
 * Measured on this rig instead of reasoned about:
 *
 *   healthy                   0.55, 0.58, 0.55 over three runs — a spread of 0.03
 *   one call per candidate    1.67   (the WEAKEST regression available: the real pre-#78 code made
 *                                     three calls per candidate, which is the 3.34 above)
 *
 * The limit is 1.2. That is roughly twice the healthy value, so ordinary variation cannot reach it,
 * and it still fails the weakest regression with margin to spare. Anything worse fails harder.
 *
 * The healthy ratio is below 1.0 for a structural reason worth knowing: a request that walks a fully
 * exhausted pool is REFUSED, so it never makes the upstream call or the bookkeeping that follows
 * one. Deep is cheaper than shallow while the walk costs a single call, and stops being so the
 * moment it does not.
 *
 * Runs LAST, because it deliberately exhausts every key in the pool and leaves the gateway with no
 * capacity — any check after it would be measuring a gateway that can only answer 503.
 */
async function checkRoutingWalkIsFlat(h: Harness): Promise<Check> {
  const base = {
    name: 'routing walk stays flat', unit: 'deep/shallow round trips per request',
    wasBefore: 'a ratio of 3.34 before PR #78; 0.74 after',
  };
  if (!REDIS_URL) {
    return { ...base, measured: null, limit: 0, skipped: 'no GUARD_REDIS_URL — needs a real Redis to watch' };
  }

  // The cache would otherwise add a lookup to every request here. It affects both bands equally so
  // the ratio would survive, but a measurement with a known contaminant left in it is one more
  // thing the next person has to reason about.
  await fetch(`${h.gatewayUrl}/admin/settings/cache`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    body: JSON.stringify({ enabled: false, ttlSeconds: 3600 }),
  });

  const auth = { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` };
  const pools = await fetch(`${h.gatewayUrl}/admin/providers`, { headers: auth })
    .then((r) => r.json() as Promise<{ providers?: { id: string }[] }>);
  const poolId = pools.providers?.[0]?.id;
  if (!poolId) return { ...base, measured: null, limit: 0, skipped: 'no pool to add keys to' };

  for (let k = 1; k < WALK_KEYS; k++) {
    await fetch(`${h.gatewayUrl}/admin/providers/${poolId}/keys`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        apiKey: `sk-guard-walk-${k}`, label: `walk ${k}`,
        rpmLimit: WALK_RPM, tpmLimit: 10_000_000, verify: false,
      }),
    });
  }

  // Clamp EVERY key including the harness's own, which starts at 100,000,000 rpm and would
  // otherwise absorb the entire run — `bench:routing` shipped that bug once and reported a
  // beautifully flat curve for a walk that never happened. Counted, and asserted below.
  const keys = await fetch(`${h.gatewayUrl}/admin/providers/${poolId}/keys`, { headers: auth })
    .then((r) => r.json() as Promise<{ keys?: { id: string }[] }>);
  let clamped = 0;
  for (const k of keys.keys ?? []) {
    const res = await fetch(`${h.gatewayUrl}/admin/keys/${k.id}`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ rpmLimit: WALK_RPM, tpmLimit: 10_000_000 }),
    });
    if (res.ok) clamped++;
  }
  if (clamped < WALK_KEYS) {
    return {
      ...base, measured: null, limit: 0,
      skipped: `only ${clamped} of ${WALK_KEYS} keys clamped — without every key limited nothing exhausts`,
    };
  }

  let n = 900_000; // clear of every other check's prompts, so nothing is a sticky or cache hit
  const send = async (): Promise<number> => {
    const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(completionBody(n++)),
    });
    await r.text();
    return r.status;
  };

  const client = new Redis(REDIS_URL);
  try {
    /** Round trips and Lua-internal calls over `count` requests, watched live. */
    const band = async (count: number): Promise<{ trips: number; lua: number; ok: number }> => {
      // `monitor()` opens its own dedicated connection and returns it — a client in monitor mode
      // can do nothing else. Duplicating first would leak a second connection per band.
      const mon = await client.monitor();
      let trips = 0; let lua = 0;
      // ioredis parses MONITOR's origin field for us. Redis reports `lua` for a call made INSIDE a
      // script; anything else is a client address, and only those crossed the network.
      mon.on('monitor', (_time: string, _args: string[], source: string) => {
        if (String(source ?? '').trim().startsWith('lua')) lua++; else trips++;
      });
      await sleep(300);

      let ok = 0;
      for (let i = 0; i < count; i++) if (await send() === 200) ok++;
      await sleep(300);
      mon.disconnect();
      return { trips, lua, ok };
    };

    // Warm, so one-time work lands outside both bands.
    for (let i = 0; i < 3; i++) await send();
    await sleep(500);

    const shallow = await band(WALK_RPM);

    // Spend the rest of the pool's headroom. After this every key is out of RPM, so each further
    // request must walk all of them before it can be refused — the case worth guarding.
    for (let i = 0; i < WALK_KEYS * WALK_RPM; i++) await send();

    const deep = await band(WALK_RPM);

    // ── Self-validation, before any verdict ───────────────────────────────────────────────────
    //
    // Each of these means the measurement did not happen, which must never be reported as a pass.
    // The origin check is the important one: the gateway's select-and-reserve script makes several
    // internal calls per request, so a run that sees NONE tagged `lua` is a run whose origin
    // detection is not working — and that failure would silently count Lua-internal calls as
    // network hops, which is the exact error this check exists to be immune to.
    if (shallow.trips + shallow.lua === 0 || deep.trips + deep.lua === 0) {
      return { ...base, measured: null, limit: 0, skipped: 'MONITOR produced no events' };
    }
    if (shallow.lua === 0 && deep.lua === 0) {
      return {
        ...base, measured: null, limit: 0,
        skipped: 'no call was tagged as Lua-internal — origin detection is not working, and without '
          + 'it this would count a script\'s internal calls as network round trips',
      };
    }
    if (shallow.ok === 0) {
      return { ...base, measured: null, limit: 0, skipped: 'the shallow band served nothing — the fixture is wrong' };
    }
    if (deep.ok === WALK_RPM) {
      return {
        ...base, measured: null, limit: 0,
        skipped: 'the deep band was still fully served, so the pool never exhausted and no walk was measured',
      };
    }

    return {
      ...base,
      measured: (deep.trips / WALK_RPM) / (shallow.trips / WALK_RPM),
      limit:    parseFloat(process.env.GUARD_MAX_WALK_RATIO ?? '1.2'),
    };
  } finally {
    client.disconnect();
  }
}

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
    // Last: it exhausts every key in the pool on purpose, and leaves a gateway that can only 503.
    checks.push(await checkRoutingWalkIsFlat(h));
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
