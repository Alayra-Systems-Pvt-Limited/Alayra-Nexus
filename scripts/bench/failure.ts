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

// What happens when things break?
//
//   docker run -d --name nexus-ops-redis -p 56379:6379 redis:7-alpine
//   npm run build && npm run bench:failures
//
// ── Why this is not a latency benchmark ───────────────────────────────────────────────────────
//
// Every other script here measures a gateway that is working. The resilience machinery — strikes,
// cooldowns, half-open probes, credential bans — only runs when something is broken, which means it
// is the least exercised code in the product and the code whose failure is most expensive. It has
// unit tests. Nothing had ever watched it work end to end against a provider that was actually
// misbehaving.
//
// So the numbers here are counts and behaviours, not milliseconds:
//
//   How much traffic does a dead provider swallow before it is isolated? That is the blast radius
//   of an outage, and it is the number an operator feels.
//
//   How many requests does a wrong credential waste before it is out of rotation?
//
//   When a cooling key becomes eligible again, does exactly ONE request go to the provider to find
//   out whether it recovered — or does everything in flight stampede at it? A breaker that
//   half-opens into a thundering herd re-kills a provider that was coming back, and the failure
//   looks like the provider flapping rather than like us.
//
//   And when Redis disappears — where every one of those decisions is stored — does the gateway
//   fail open, fail closed, or fall over? This one has no expected answer written down anywhere,
//   which is the reason to measure it.
//
// ── Counted at the provider ───────────────────────────────────────────────────────────────────
//
// Every claim below is checked against the mock upstream's own request counter rather than against
// our logs. "The breaker isolated the key" and "the provider stopped receiving requests" are the
// same statement only if the second one is what you measured.

import { execFileSync } from 'node:child_process';
import { completionBody, setUpstream, startHarness, type Harness } from './gateway';
import {
  STRIKE_THRESHOLD, AUTH_BAN_THRESHOLD, BASE_COOLDOWN_SECONDS,
} from '../../src/lib/breaker';

const REDIS_CONTAINER = process.env.OPS_REDIS_CONTAINER ?? 'nexus-ops-redis';
const REDIS_PORT = parseInt(process.env.OPS_REDIS_PORT ?? '56379', 10);
/** Requests sent after a provider starts failing, to see where they end up. */
const PROBE_REQUESTS = parseInt(process.env.FAIL_REQUESTS ?? '12', 10);
/** Concurrent callers used to test whether half-open lets exactly one through. */
const HERD = parseInt(process.env.FAIL_HERD ?? '20', 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }) ?? '';

interface Stats { requests: number; byStatus: Record<string, number> }

const mockStats  = (u: string): Promise<Stats> => fetch(`${u}/__stats`).then((r) => r.json() as Promise<Stats>);
const resetMock  = (u: string): Promise<unknown> => fetch(`${u}/__reset`, { method: 'POST' });

/** One completion. Never throws — a transport failure is an outcome worth recording, not a crash. */
async function send(h: Harness, n: number, timeoutMs = 15_000): Promise<number> {
  try {
    const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(completionBody(n)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await r.text();
    return r.status;
  } catch {
    return 0; // no response at all
  }
}

/** Is the process still there at all? The difference between "stuck" and "dead". */
async function gatewayAlive(h: Harness): Promise<boolean> {
  try {
    return (await fetch(`${h.gatewayUrl}/health`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

/** Statuses as a compact string, e.g. `9x503 3x200`. */
function tally(codes: number[]): string {
  const counts = new Map<number, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n}x${code === 0 ? 'no-response' : code}`).join(' ');
}

const auth = (h: Harness) => ({
  'content-type': 'application/json', authorization: `Bearer ${h.adminToken}`,
});

/**
 * Headers for a POST that carries NO body.
 *
 * Fastify refuses a request that declares `content-type: application/json` and then sends nothing,
 * with a 400. Reusing the JSON headers on bodyless admin actions therefore made every `unban` call
 * fail silently — the script read the 400 as success, keys stayed cooling, and two later scenarios
 * measured a gateway with no usable keys and blamed the result on what they were testing.
 *
 * The gateway is right to refuse it. This is the same class of mistake the e2e suite was written to
 * catch ("the bodyless-request rejections"), arriving here from the other side.
 */
const authNoBody = (h: Harness) => ({ authorization: `Bearer ${h.adminToken}` });

/** How many keys the pool currently has in service. */
async function activeKeys(h: Harness): Promise<number> {
  const id = await poolId(h);
  const keys = await fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, { headers: auth(h) })
    .then((r) => r.json() as Promise<{ keys?: { status: string }[] }>);
  return (keys.keys ?? []).filter((k) => k.status !== 'banned').length;
}

async function poolId(h: Harness): Promise<string> {
  const pools = await fetch(`${h.gatewayUrl}/admin/providers`, { headers: auth(h) })
    .then((r) => r.json() as Promise<{ providers?: { id: string }[] }>);
  const id = pools.providers?.[0]?.id;
  if (!id) throw new Error('no pool');
  return id;
}

/**
 * Put every key in the pool back into service and clear its breaker state.
 *
 * Verified rather than assumed, and that is not defensiveness. The first version of this script
 * fired the unban calls and moved on; two scenarios later every request was a 503 because the keys
 * had never come back, and the output blamed the gateway for it. A setup step that quietly does
 * nothing produces a benchmark that confidently measures the wrong thing — the same failure
 * `bench:routing` already had once, with its silent 404 on a clamp that never ran.
 *
 * `nexus:breaker:auth:*` is cleared directly because `onSuccess` — which is what the unban route
 * calls — deletes strikes, cooldown, open and probe, but NOT the auth counter. It is a deliberate
 * asymmetry in the product (a revoked credential should not be forgiven by one success), and it
 * means an unbanned key here would be re-banned by its very next 401 rather than after two.
 */
async function healAll(h: Harness): Promise<void> {
  const id = await poolId(h);
  const list = (): Promise<{ keys?: { id: string; status: string }[] }> =>
    fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, { headers: auth(h) })
      .then((r) => r.json() as Promise<{ keys?: { id: string; status: string }[] }>);

  const keys = await list();
  for (const k of keys.keys ?? []) {
    const res = await fetch(`${h.gatewayUrl}/admin/keys/${k.id}/unban`, {
      method: 'POST', headers: authNoBody(h),
    });
    // Checked, because an unchecked one is how this went wrong the first time.
    if (!res.ok) throw new Error(`unban ${k.id} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  for (const pattern of ['nexus:breaker:*']) {
    docker(['exec', REDIS_CONTAINER, 'redis-cli', '--scan', '--pattern', pattern])
      .split(/\r?\n/).filter(Boolean)
      .forEach((key) => { docker(['exec', REDIS_CONTAINER, 'redis-cli', 'del', key]); });
  }

  // The key-row cache holds rows for a second. Waiting it out costs nothing here and removes the
  // one way a scenario could start against a key the router still believes is banned.
  await sleep(1_200);

  const after = await list();
  const stuck = (after.keys ?? []).filter((k) => k.status !== 'active');
  if (stuck.length > 0) {
    throw new Error(
      `heal failed: ${stuck.length} key(s) still ${stuck.map((k) => k.status).join(', ')}. `
      + 'Every scenario after this one would measure a gateway with no usable keys and blame the '
      + 'result on whatever it was testing.',
    );
  }
}

// ── 1. A provider returning 500 ───────────────────────────────────────────────────────────────

async function serverFailures(h: Harness): Promise<void> {
  console.log('── A provider that has started returning 500 ──────────────────────────────────\n');
  console.log(`The breaker trips after ${STRIKE_THRESHOLD} consecutive server failures. What matters is`);
  console.log('what happens to the requests AFTER that — whether they keep reaching a provider that');
  console.log('is known to be broken.\n');

  await healAll(h);
  await setUpstream(h.mockUrl, { status: 500 });
  await resetMock(h.mockUrl);

  const codes: number[] = [];
  let reachedWhenTripped = 0;
  for (let i = 0; i < PROBE_REQUESTS; i++) {
    codes.push(await send(h, 10_000 + i));
    if (i === STRIKE_THRESHOLD - 1) reachedWhenTripped = (await mockStats(h.mockUrl)).requests;
  }
  const reached = (await mockStats(h.mockUrl)).requests;

  console.log(`  requests sent                       ${PROBE_REQUESTS}`);
  console.log(`  reached the provider                ${reached}`);
  console.log(`  ...of which before the breaker      ${reachedWhenTripped}`);
  console.log(`  the caller saw                      ${tally(codes)}`);
  console.log('');
  const wasted = reached - reachedWhenTripped;
  if (reached <= STRIKE_THRESHOLD) {
    console.log(`  ✓ The blast radius is ${reached} requests. Once tripped, the key was skipped without`);
    console.log('    the provider being contacted again — the failure is bounded by the strike');
    console.log('    threshold rather than by how long the outage lasts.');
  } else {
    console.log(`  ⚠ ${wasted} requests reached the provider AFTER the breaker should have tripped.`);
    console.log('    An outage of any length keeps costing calls, which is what the breaker exists');
    console.log('    to stop.');
  }
  console.log('');
}

// ── 2. A credential that is simply wrong ──────────────────────────────────────────────────────

async function authFailures(h: Harness): Promise<void> {
  console.log('── A key whose credential is rejected ─────────────────────────────────────────\n');
  console.log(`A 401 is not a transient failure — it will not recover on its own, so ${AUTH_BAN_THRESHOLD} of them`);
  console.log('bans the key outright rather than cooling it. With two keys in the pool, the');
  console.log('question is how much is wasted before BOTH are out of rotation.\n');

  await healAll(h);
  const id = await poolId(h);
  const before = await fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, { headers: auth(h) })
    .then((r) => r.json() as Promise<{ keys?: unknown[] }>);
  if ((before.keys?.length ?? 0) < 2) {
    await fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, {
      method: 'POST', headers: auth(h),
      body: JSON.stringify({
        apiKey: 'sk-bench-second', label: 'second', rpmLimit: 100_000_000,
        tpmLimit: 100_000_000, verify: false,
      }),
    });
  }
  await healAll(h);

  await setUpstream(h.mockUrl, { status: 401 });
  await resetMock(h.mockUrl);

  const codes: number[] = [];
  for (let i = 0; i < PROBE_REQUESTS; i++) codes.push(await send(h, 20_000 + i));
  const reached = (await mockStats(h.mockUrl)).requests;

  const keys = await fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, { headers: auth(h) })
    .then((r) => r.json() as Promise<{ keys?: { status: string }[] }>);
  const banned = (keys.keys ?? []).filter((k) => k.status === 'banned').length;

  console.log(`  requests sent                       ${PROBE_REQUESTS}`);
  console.log(`  reached the provider                ${reached}`);
  console.log(`  keys banned                         ${banned} of ${keys.keys?.length ?? 0}`);
  console.log(`  the caller saw                      ${tally(codes)}`);
  console.log('');
  const expected = (keys.keys?.length ?? 0) * AUTH_BAN_THRESHOLD;
  console.log(`  ${reached <= expected ? '✓' : '⚠'} A wrong credential costs ${reached} rejected calls before it stops being tried`);
  console.log(`    (${AUTH_BAN_THRESHOLD} per key x ${keys.keys?.length ?? 0} keys = ${expected} is the design).`);
  console.log('');
}

// ── 3. Half-open: one probe, or a stampede? ───────────────────────────────────────────────────

async function halfOpenHerd(h: Harness): Promise<void> {
  console.log('── The moment a cooling key becomes eligible again ────────────────────────────\n');
  console.log('The most dangerous moment in a breaker. The cooldown expires and every request in');
  console.log('flight becomes eligible at the same instant. If they all go, a provider that was');
  console.log('recovering is re-killed, and it looks like the provider flapping rather than us.');
  console.log(`${HERD} callers arrive together the moment the key half-opens.\n`);

  await healAll(h);
  await setUpstream(h.mockUrl, { status: 500 });

  // Drive failures until the provider STOPS receiving them — that, and not a request count, is
  // what "the breaker is open" means from outside.
  //
  // The first version sent exactly STRIKE_THRESHOLD requests, which is right for one key and wrong
  // for any other number: the pool had picked up a second key in the previous scenario, the three
  // failures split across both, neither reached the threshold, and the burst below then flooded a
  // provider whose breaker had never tripped. The script reported that as a stampede — a false
  // alarm against the product, produced entirely by its own fixture.
  const MAX_TRIP = STRIKE_THRESHOLD * 10;
  let tripped = false;
  for (let i = 0; i < MAX_TRIP; i++) {
    const before = (await mockStats(h.mockUrl)).requests;
    await send(h, 30_000 + i);
    if ((await mockStats(h.mockUrl)).requests === before) { tripped = true; break; }
  }
  if (!tripped) {
    console.log(`  ⚠ SKIPPED — ${MAX_TRIP} failing requests did not stop reaching the provider, so no`);
    console.log('    breaker had opened and there is no half-open moment to observe.\n');
    return;
  }

  console.log(`  every key is now gated; waiting out the ${BASE_COOLDOWN_SECONDS}s cooldown…`);
  await sleep((BASE_COOLDOWN_SECONDS + 1) * 1_000);

  const keyCount = await activeKeys(h);
  await resetMock(h.mockUrl);
  const burst = await Promise.all(
    Array.from({ length: HERD }, (_, i) => send(h, 31_000 + i)),
  );
  const probes = (await mockStats(h.mockUrl)).requests;

  console.log(`  callers arriving at once            ${HERD}`);
  console.log(`  keys in the pool                    ${keyCount}`);
  console.log(`  requests that reached the provider  ${probes}`);
  console.log(`  the callers saw                     ${tally(burst)}`);
  console.log('');
  // The breaker is per KEY, so the guarantee is one probe per key — not one per pool. Asserting a
  // flat 1 was right only while the pool had a single key, and would have called correct behaviour
  // a stampede the moment a second one existed.
  if (probes > 0 && probes <= keyCount) {
    console.log(`  ✓ ${probes} probe${probes === 1 ? '' : 's'} for ${keyCount} key${keyCount === 1 ? '' : 's'}, from ${HERD} simultaneous callers. The half-open slot is`);
    console.log('    claimed atomically per key, so a recovering provider sees one trial request per');
    console.log('    credential however many callers are queued behind it.');
  } else if (probes === 0) {
    console.log('  ⚠ None. The cooldown had not expired, or the probe slot was still held from an');
    console.log('    earlier attempt. Not a stampede, but not a recovery test either.');
  } else {
    console.log(`  ✗ ${probes} requests reached a provider that was still cooling, with only ${keyCount} key(s)`);
    console.log('    to probe. The breaker half-opened into a stampede, which is what re-kills a');
    console.log('    provider that is coming back.');
  }

  // The other half of the contract: once the provider is healthy, does a successful probe actually
  // return the key to service?
  //
  // Measured AFTER the burst, not inside it. The first version asserted on the burst itself and
  // called one success in twenty a warning — which is exactly backwards. Nineteen refusals there
  // are the feature: they are the callers that arrived while the single probe was still in flight,
  // and letting them through is the stampede the previous phase exists to prevent. What proves
  // recovery is the traffic that comes next.
  console.log('');
  console.log('  provider now healthy again; waiting out the escalated cooldown…');
  await setUpstream(h.mockUrl, { status: 200 });
  await sleep((BASE_COOLDOWN_SECONDS * 2 + 1) * 1_000);
  await resetMock(h.mockUrl);

  const probeBurst = await Promise.all(Array.from({ length: HERD }, (_, i) => send(h, 32_000 + i)));
  const probeOk = probeBurst.filter((s) => s === 200).length;
  console.log(`  the probing burst saw               ${tally(probeBurst)}`);

  // Sequential, so each one is decided after the probe has reported its result.
  const resumed: number[] = [];
  for (let i = 0; i < 10; i++) resumed.push(await send(h, 33_000 + i));
  const back = resumed.filter((s) => s === 200).length;

  console.log(`  the next ${resumed.length} requests saw          ${tally(resumed)}`);
  console.log('');
  if (probeOk >= 1 && back === resumed.length) {
    console.log('  ✓ One probe succeeded and the breaker closed. Traffic resumed on its own — no');
    console.log('    operator action, and no window where the key stayed dark after the provider');
    console.log('    was already healthy.');
  } else if (probeOk >= 1) {
    console.log(`  ⚠ The probe succeeded but only ${back} of ${resumed.length} later requests did. The breaker is not`);
    console.log('    closing cleanly on a successful probe.');
  } else {
    console.log('  ✗ No probe succeeded against a healthy provider, so the key never came back.');
  }
  console.log('');
}

// ── 4. Redis disappears ───────────────────────────────────────────────────────────────────────

async function redisDown(h: Harness): Promise<void> {
  console.log('── Redis disappears ──────────────────────────────────────────────────────────\n');
  console.log('Every routing decision — breaker state, rate limits, sticky pins — lives in Redis.');
  console.log('There is no documented answer anywhere for what the gateway does without it, which');
  console.log('is the reason to find out rather than to assume.\n');

  await healAll(h);
  await setUpstream(h.mockUrl, { status: 200 });
  await resetMock(h.mockUrl);

  const healthy = await send(h, 40_000);
  if (healthy !== 200) {
    throw new Error(
      `the baseline request returned ${healthy} with Redis UP. Everything below would be measuring `
      + 'a gateway that was already broken before Redis was touched.',
    );
  }

  docker(['stop', REDIS_CONTAINER]);
  await sleep(1_000);

  // Reset AFTER the baseline, so the counter covers only the outage window. Subtracting one for the
  // baseline instead produced a "-1 reached the provider" in the first run — arithmetic standing in
  // for a measurement, and wrong the moment the baseline did not reach the provider at all.
  await resetMock(h.mockUrl);
  const during: number[] = [];
  for (let i = 0; i < 5; i++) during.push(await send(h, 41_000 + i));
  const reachedDuring = (await mockStats(h.mockUrl)).requests;
  // Asked here, not only at the end. "Refused every request" and "stopped existing" look identical
  // from the client side, and calling the second one "failed closed" would credit the gateway with
  // a deliberate safety behaviour it did not perform.
  const aliveDuring = await gatewayAlive(h);

  docker(['start', REDIS_CONTAINER]);
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', REDIS_CONTAINER, 'redis-cli', 'ping']); break; } catch { await sleep(500); }
  }
  const redisBackAt = Date.now();

  // Poll rather than wait a fixed moment, and REPORT how long it took.
  //
  // A fixed 2s wait passed when this scenario ran alone and failed in a full run, which is the
  // signature of a client backing off further the longer it has been failing. "Did it recover"
  // answered by a stopwatch that arbitrary is not an answer; how long recovery takes is the useful
  // number anyway, because it is the tail of the outage an operator actually experiences.
  // A SHORT timeout on the probe, or the budget is spent waiting rather than polling: at the
  // 15-second default, sixty seconds buys four attempts, and "still failing after 60s" would really
  // mean "tried four times". Three seconds is long enough for a healthy answer and short enough to
  // give the budget back to actual retries.
  const RECOVERY_BUDGET_MS = 60_000;
  const deadline = Date.now() + RECOVERY_BUDGET_MS;
  let recoveredAfterMs: number | null = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (await send(h, 42_900 + attempts, 3_000) === 200) {
      recoveredAfterMs = Date.now() - redisBackAt;
      break;
    }
    await sleep(1_000);
  }

  const after: number[] = [];
  for (let i = 0; i < 5; i++) after.push(await send(h, 42_000 + i));

  console.log(`  before, with Redis up               ${healthy}`);
  console.log(`  while Redis was down                ${tally(during)}`);
  console.log(`  ...of which reached the provider    ${reachedDuring}`);
  console.log(`  after Redis came back               ${tally(after)}`);
  console.log('');

  const servedWhileDown = during.filter((s) => s === 200).length;
  const recovered = after.filter((s) => s === 200).length;
  const hung      = during.filter((s) => s === 0).length;
  const refused   = during.filter((s) => s >= 500).length;

  if (!aliveDuring) {
    console.log('  The gateway DIED. It did not fail closed — failing closed is a decision, and this');
    console.log('  process stopped answering /health altogether. Every request after that point is a');
    console.log('  consequence of the crash rather than a routing decision, including the ones this');
    console.log('  script recorded as refusals.');
    console.log('');
    console.log('  This is the most serious outcome available here: a dependency blip becomes a');
    console.log('  process exit, and the gateway does not come back when the dependency does.');
  } else if (servedWhileDown === during.length) {
    console.log('  The gateway FAILED OPEN: it kept serving with no rate limiting, no breaker and no');
    console.log('  sticky routing. Traffic survives a Redis outage — and so does a key that should');
    console.log('  have been cooling, and a rate limit that should have refused. Worth knowing which');
    console.log('  of those two an operator would rather have.');
  } else if (servedWhileDown === 0) {
    console.log('  The gateway FAILED CLOSED: it refused rather than route without its state, and');
    console.log('  stayed up while doing it. No limit was exceeded and no banned key was used, at the');
    console.log('  cost of total unavailability for as long as Redis is gone.');
  } else {
    console.log(`  MIXED: ${servedWhileDown} of ${during.length} were served. Partial behaviour is the hardest kind to`);
    console.log('  reason about during an incident, and worth understanding before one.');
  }
  console.log('');
  if (recoveredAfterMs === null) {
    // Two very different faults look identical from the client side, and reporting one as the other
    // would be a serious mischaracterisation of the product. `/health` separates them.
    const alive = await gatewayAlive(h);
    console.log(`  ✗ Still failing ${(RECOVERY_BUDGET_MS / 1000).toFixed(0)}s and ${attempts} attempts after Redis came back.`);
    if (alive) {
      console.log('    The process is ALIVE and answering /health, so this is a stuck key-value client');
      console.log('    rather than a crash — the gateway is up and cannot route.');
    } else {
      console.log('    The process is NOT answering /health either: it did not survive the outage.');
      console.log('    A dependency that came back by itself has left a gateway that needs a restart,');
      console.log('    which is the most serious thing this script can find.');
    }
    const log = h.log();
    const tail = log.split(/\r?\n/).filter(Boolean).slice(-8);
    if (tail.length) {
      console.log('');
      console.log('    last lines from the gateway:');
      for (const line of tail) console.log(`      ${line.slice(0, 160)}`);
    }
  } else {
    console.log(`  ✓ Recovered on its own ${(recoveredAfterMs / 1000).toFixed(1)}s after Redis answered again, with no restart`);
    console.log(`    and no operator action; ${recovered} of ${after.length} follow-up requests then succeeded.`);
    console.log('    That delay is part of the outage a caller experiences, not part of Redis\'s.');
  }

  // HOW it fails matters as much as whether it fails, and the two are not the same finding. A
  // caller can handle an immediate refusal: retry, fail over, shed load. A request that hangs until
  // something else times it out holds a connection at both ends for the duration, and a client pool
  // saturates long before the operator has worked out which dependency is down.
  if (hung > 0) {
    console.log('');
    console.log(`  ⚠ ${hung} of ${during.length} requests returned NOTHING — they hung until this script timed them`);
    console.log(`    out, while ${refused} were refused promptly. Failing fast and failing slow are very`);
    console.log('    different outcomes for a caller: a hung request holds a connection at both ends,');
    console.log('    and a client pool saturates well before anyone has identified the cause.');
    console.log('    Worth deciding deliberately rather than inheriting from ioredis\'s retry defaults.');
  }
  if (refused > 0 && during.filter((s) => s === 503).length === 0) {
    console.log('');
    console.log('  ⚠ The prompt refusals were 500, not 503. A dependency being down is exactly what 503');
    console.log('    means, and it is the code that carries Retry-After — a caller can act on it, where');
    console.log('    a 500 only says something is broken.');
  }
  console.log('');
}

async function main(): Promise<void> {
  const redisUrl = `redis://127.0.0.1:${REDIS_PORT}/0`;
  docker(['exec', REDIS_CONTAINER, 'redis-cli', 'flushall']);

  console.log('');
  console.log('Behaviour under failure. Counts, not milliseconds — every claim is checked against');
  console.log("the provider's own request counter rather than against our logs.");
  console.log('');

  // FAIL_ONLY=half-open runs a single scenario. The breaker's cooldowns make a full run minutes
  // long, and iterating on one scenario should not require sitting through the other three.
  const only = (process.env.FAIL_ONLY ?? '').trim();
  const wanted = (name: string): boolean => only === '' || only === name;

  const h = await startHarness(3210, 3401, { redisUrl });
  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });
    if (wanted('5xx'))       await serverFailures(h);
    if (wanted('auth'))      await authFailures(h);
    if (wanted('half-open')) await halfOpenHerd(h);
    if (wanted('redis'))     await redisDown(h);
  } finally {
    // Leave Redis running whatever happened above, or the next run starts against a stopped
    // container and reports a failure that belongs to this script.
    try { docker(['start', REDIS_CONTAINER]); } catch { /* already running */ }
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
