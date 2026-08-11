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

// Does one key's rate limit hold across two gateways?
//
//   npm run build && npm run bench:multi-instance
//
// ── The claim being tested ────────────────────────────────────────────────────────────────────
//
// Nexus says a provider key's RPM limit is shared: run four gateways behind a load balancer and a
// key rated at 60 requests a minute still serves 60, not 240. The mechanism is real and readable —
// `ADMIT_LUA` in src/lib/admission.ts checks and increments in one Redis round trip, so two
// gateways cannot both pass a check only one should.
//
// Reading it is not the same as running it. Until this file, every measurement in this directory
// used ONE gateway process, or one gateway forked across cores with `workers`. Forks are a weak
// version of the question: siblings on one machine, started together from one configuration,
// sharing a listening socket. Two instances are what a deployment is — separate processes, separate
// caches, separate connection pools, agreeing only through Postgres and Redis.
//
// ── Why the negative control is the important half ────────────────────────────────────────────
//
// A run that reports "the limit held" proves nothing on its own, because a rig that never generates
// enough load, or sends everything to one instance, reports exactly the same thing. So every
// scenario runs twice: once with the shared Redis, and once with the instances given no Redis at
// all, which leaves each holding its own counters in process memory.
//
// The second run is supposed to FAIL to hold the limit. If it does not, the rig is not measuring
// what it claims and the first result should be thrown away rather than published. That check is
// the difference between a benchmark and a green tick.

import Redis from 'ioredis';
import {
  containersUp, containersDown, waitForPostgres, waitForRedis,
  createDatabase, migrate, redisUrlFor,
} from './containers';
import { startHarness, completionBody, type Harness } from './gateway';

/** Requests a minute the pool key is rated for. */
const LIMIT = parseInt(process.env.BENCH_RPM_LIMIT ?? '60', 10);
/** Total requests driven, split between the two instances. Four times the limit, so a per-instance
 *  budget and a shared one are separated by far more than noise. */
const REQUESTS = parseInt(process.env.BENCH_REQUESTS ?? '240', 10);
/** In flight at once, across both instances. */
const CONCURRENCY = parseInt(process.env.BENCH_CONCURRENCY ?? '16', 10);

const MOCK_PORT = 3215;
const PORT_A = 3411;
const PORT_B = 3412;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  /** Requests the gateway served — the provider was actually called. */
  served: number;
  /** Requests refused for want of capacity: every key was at its limit. */
  refused: number;
  /** Anything else. Always reported; anything above zero makes the run untrustworthy. */
  other: Record<number, number>;
}

const empty = (): Outcome => ({ served: 0, refused: 0, other: {} });
const total = (o: Outcome): number => o.served + o.refused + Object.values(o.other).reduce((a, b) => a + b, 0);

/**
 * Drive `REQUESTS` requests, alternating between the two gateways, and record what each answered.
 *
 * Alternating rather than splitting into halves: two sequential halves would let the first instance
 * spend the whole budget before the second sent anything, and "the limit held" would then be
 * indistinguishable from "only one instance was ever asked". The per-instance counts are reported
 * for the same reason.
 */
async function drive(urls: [string, string], apiKey: string): Promise<[Outcome, Outcome]> {
  const outcomes: [Outcome, Outcome] = [empty(), empty()];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const n = next++;
      if (n >= REQUESTS) return;
      const which = n % 2;
      let status: number;
      try {
        const r = await fetch(`${urls[which]}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          // A unique body per request, so nothing is answered from the sticky fast path or the
          // response cache. Either would take the request off the admission path entirely and
          // quietly inflate the served count.
          body: JSON.stringify(completionBody(n)),
        });
        status = r.status;
        await r.text();
      } catch { status = 0; }

      const o = outcomes[which];
      if (status === 200) o.served++;
      else if (status === 503) o.refused++;      // no key had capacity — see completionsProxy
      else o.other[status] = (o.other[status] ?? 0) + 1;
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return outcomes;
}

/** The pool key both instances route through, and the limit it is rated for. */
async function rateLimitTheKey(h: Harness, rpmLimit: number): Promise<string> {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` };

  const pools = await (await fetch(`${h.gatewayUrl}/admin/providers`, { headers: auth })).json() as
    { providers: Array<{ id: string }> };
  const poolId = pools.providers?.[0]?.id;
  if (!poolId) throw new Error('no provider pool to rate-limit');

  const keys = await (await fetch(`${h.gatewayUrl}/admin/providers/${poolId}/keys`, { headers: auth })).json() as
    { keys: Array<{ id: string }> };
  const keyId = keys.keys?.[0]?.id;
  if (!keyId) throw new Error('no provider key to rate-limit');

  const patch = await fetch(`${h.gatewayUrl}/admin/keys/${keyId}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ rpmLimit, tpmLimit: 100_000_000 }),
  });
  if (!patch.ok) throw new Error(`could not set the limit: ${patch.status} ${await patch.text()}`);

  // The routing key row is cached for a second, and the other instance never saw the write at all —
  // its copy only goes stale on that TTL. Driving load before it does would measure the OLD limit
  // on one instance and the new one on the other, which looks exactly like a broken shared bucket.
  await sleep(2_000);
  return keyId;
}

interface Scenario {
  label: string;
  shared: boolean;
  a: Outcome;
  b: Outcome;
  /** The counter Redis holds for this key afterwards, or null when nothing is there. */
  redisCounter: number | null;
}

async function scenario(label: string, shared: boolean, index: number): Promise<Scenario> {
  const databaseUrl = createDatabase(`nexus_multi_${index}`);
  migrate(databaseUrl);
  const redisUrl = redisUrlFor(index);

  // Both instances get the same Postgres either way. Only Redis changes, so the two scenarios
  // differ in exactly one thing — which is the only way the comparison means anything.
  const common = { databaseUrl, ...(shared ? { redisUrl } : {}) };

  let a: Harness | undefined;
  let b: Harness | undefined;
  try {
    a = await startHarness(MOCK_PORT, PORT_A, common);
    // The same database, already claimed. It shares the mock upstream too, which is deliberate:
    // a second mock would give the two instances different upstream latencies and turn a rate-limit
    // measurement into a race between two providers.
    b = await startHarness(MOCK_PORT, PORT_B, { ...common, joinExisting: true });

    const keyId = await rateLimitTheKey(a, LIMIT);
    const [outA, outB] = await drive([a.gatewayUrl, b.gatewayUrl], a.apiKey);

    let redisCounter: number | null = null;
    if (shared) {
      const client = new Redis(redisUrl);
      try {
        const raw = await client.get(`nexus:rpm:${keyId}`);
        redisCounter = raw === null ? null : Number(raw);
      } finally { client.disconnect(); }
    }

    return { label, shared, a: outA, b: outB, redisCounter };
  } finally {
    a?.dispose();
    b?.dispose();
  }
}

function report(s: Scenario): void {
  const served = s.a.served + s.b.served;
  const refused = s.a.refused + s.b.refused;
  const other = { ...s.a.other, ...s.b.other };
  const strays = Object.entries(other).map(([k, v]) => `${v}x${k}`).join(' ') || 'none';

  console.log(`\n  ${s.label}`);
  console.log(`    instance A   served ${String(s.a.served).padStart(4)}   refused ${String(s.a.refused).padStart(4)}`);
  console.log(`    instance B   served ${String(s.b.served).padStart(4)}   refused ${String(s.b.refused).padStart(4)}`);
  console.log(`    together     served ${String(served).padStart(4)}   refused ${String(refused).padStart(4)}   other ${strays}`);
  console.log(`    the key was rated for ${LIMIT}/min, and served ${(served / LIMIT).toFixed(2)}x that`);
  if (s.shared) {
    console.log(`    redis holds nexus:rpm:<key> = ${s.redisCounter ?? 'nothing'}`);
  }
}

/**
 * Does a key rated for N a minute keep serving, when it is offered fewer than N a minute?
 *
 * The question this rig was not built for, and the one that reading `ADMIT_LUA` raises. It counts
 * with `INCR` and then calls `EXPIRE` on every admitted request, so the window's clock restarts
 * each time one is let through. A window whose clock restarts on use does not expire while it is
 * being used — the counter climbs, and the only thing that ever clears it is a full minute in which
 * nothing at all was admitted.
 *
 * If that reading is right, a key rated 20/min offered 15/min does not run forever. It runs for as
 * long as it takes to accumulate 20, and then refuses everything until the traffic stops.
 *
 * Measured rather than argued, because the alternative reading — that a steady trickle keeps
 * clearing the window — is just as easy to believe from the code.
 */
interface Trickle {
  offeredPerMin: number;
  limit: number;
  served: number;
  /** How long the key kept serving before it started refusing, or null if it never did. */
  firstRefusalAfterMs: number | null;
  /** How long after that it began serving again, or null if it never did. */
  recoveredAfterMs: number | null;
}

async function steadyTrickle(index: number): Promise<Trickle> {
  const LIMIT_S  = 20;         // what the key is rated for, per minute
  const BATCH    = 2;          // requests per round
  const EVERY_MS = 8_000;      // one round every 8s → 15/min offered, comfortably under the rating
  const ROUNDS   = 20;         // 160s, twice as long as it should take to expose the drift

  const databaseUrl = createDatabase(`nexus_multi_${index}`);
  migrate(databaseUrl);
  const redisUrl = redisUrlFor(index);

  let h: Harness | undefined;
  try {
    h = await startHarness(MOCK_PORT, PORT_A, { databaseUrl, redisUrl });
    await rateLimitTheKey(h, LIMIT_S);

    const started = Date.now();
    let served = 0;
    let firstRefusalAfterMs: number | null = null;

    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < BATCH; i++) {
        const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${h.apiKey}` },
          body: JSON.stringify(completionBody(round * BATCH + i)),
        });
        await r.text();
        if (r.status === 200) served++;
        else if (firstRefusalAfterMs === null) firstRefusalAfterMs = Date.now() - started;
      }
      if (firstRefusalAfterMs !== null) break;   // the answer is in; no reason to keep paying for it
      await sleep(EVERY_MS);
    }

    // Does it come back, and what does coming back cost? Refused requests return before the INCR,
    // so they do not restart the clock — which means the window can only expire during a stretch
    // where everything is being refused. Worth measuring rather than assuming, because "refuses for
    // a minute and recovers" and "refuses until the traffic stops" are very different failures.
    let recoveredAfterMs: number | null = null;
    if (firstRefusalAfterMs !== null) {
      const refusedAt = Date.now();
      for (let i = 0; i < 45; i++) {
        await sleep(2_000);
        const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${h.apiKey}` },
          body: JSON.stringify(completionBody(10_000 + i)),
        });
        await r.text();
        if (r.status === 200) { recoveredAfterMs = Date.now() - refusedAt; break; }
      }
    }

    return {
      offeredPerMin: (BATCH / EVERY_MS) * 60_000, limit: LIMIT_S, served,
      firstRefusalAfterMs, recoveredAfterMs,
    };
  } finally {
    h?.dispose();
  }
}

async function main(): Promise<void> {
  console.log(`\ntwo gateways, one key rated ${LIMIT}/min, ${REQUESTS} requests at ${CONCURRENCY} in flight\n`);

  containersUp();
  await waitForPostgres();
  await waitForRedis();

  const problems: string[] = [];
  try {
    const withRedis = await scenario('sharing one Redis — how it is deployed', true, 1);
    report(withRedis);

    const without = await scenario('no shared Redis — the control, which must NOT hold', false, 2);
    report(without);

    const sharedServed = withRedis.a.served + withRedis.b.served;
    const aloneServed  = without.a.served + without.b.served;

    console.log('\n  ── what this establishes ──────────────────────────────────────────────────');

    // 1. The rig sent enough load to matter. Without this every other line is unfalsifiable.
    if (total(withRedis.a) + total(withRedis.b) < REQUESTS) {
      problems.push('not every request was accounted for');
    }

    // 2. BOTH instances served. A shared limit that held because only one instance was ever asked
    //    is not a result, and it is the easiest way for this rig to lie.
    if (withRedis.a.served === 0 || withRedis.b.served === 0) {
      problems.push(`only one instance served anything (A ${withRedis.a.served}, B ${withRedis.b.served}) — the limit was never tested across two`);
    }

    // 3. The shared run held at roughly the rated limit. Ten percent of slack for the reconcile
    //    path and for requests admitted just before the limit bound.
    if (sharedServed > LIMIT * 1.1) {
      problems.push(`shared: served ${sharedServed} against a limit of ${LIMIT}`);
    }

    // 4. Redis really is where the counting happened.
    if (withRedis.redisCounter === null) {
      problems.push('nothing in Redis for this key — the counting happened somewhere else');
    }

    // 5. THE CONTROL. Without a shared Redis the limit must visibly fail to hold, or this rig
    //    cannot tell a working shared bucket from a broken one and neither number means anything.
    if (aloneServed < LIMIT * 1.5) {
      problems.push(`control: served only ${aloneServed}, so this rig cannot detect a limit that does NOT hold — treat the shared result as unproven`);
    }

    console.log(`    shared Redis      ${sharedServed} served, ${(sharedServed / LIMIT).toFixed(2)}x the limit`);
    console.log(`    no shared Redis   ${aloneServed} served, ${(aloneServed / LIMIT).toFixed(2)}x the limit`);
    console.log(`    the difference is the shared bucket, and it is ${(aloneServed / Math.max(sharedServed, 1)).toFixed(1)}x`);

    if (problems.length) {
      console.log('\n  NOT PROVEN:');
      for (const p of problems) console.log(`    - ${p}`);
    } else {
      console.log('\n  PROVEN: one key, two gateways, one budget — and the rig can tell when that fails.');
    }

    if (!process.env.BENCH_SKIP_TRICKLE) {
      console.log('\n  ── and the same limit over time, on one instance ──────────────────────────');
      const t = await steadyTrickle(3);
      console.log(`\n    a key rated ${t.limit}/min, offered ${t.offeredPerMin}/min — well under it`);
      if (t.firstRefusalAfterMs === null) {
        console.log(`    served all ${t.served}, no refusals. The window clears as it should.`);
      } else {
        const secs = (t.firstRefusalAfterMs / 1000).toFixed(0);
        console.log(`    served ${t.served}, then REFUSED after ${secs}s`);
        console.log(`    the key had done ${t.served} requests in ${secs}s — a rate of `
          + `${((t.served / (t.firstRefusalAfterMs / 1000)) * 60).toFixed(0)}/min against a ${t.limit}/min limit`);
        console.log('    the window never expired, because every admitted request restarted its clock');
        console.log(t.recoveredAfterMs === null
          ? '    still refusing 90s later — it does not recover while anything is still asking'
          : `    recovered ${(t.recoveredAfterMs / 1000).toFixed(0)}s later, once the refusals had gone quiet long enough`);
      }
    }
  } finally {
    if (!process.env.BENCH_KEEP_CONTAINERS) containersDown();
  }

  if (problems.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
