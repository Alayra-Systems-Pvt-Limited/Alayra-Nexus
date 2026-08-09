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

// What are the ceilings, and what does hitting one look like from outside?
//
//   docker run -d --name nexus-bench-pg -p 55433:5432 \
//     -e POSTGRES_USER=nexus -e POSTGRES_PASSWORD=nexus -e POSTGRES_DB=nexus postgres:16-alpine
//   npm run build && npm run bench:resources
//
// ── Why this one exists ───────────────────────────────────────────────────────────────────────
//
// Every other benchmark here asks what the gateway COSTS. This one asks where it STOPS, which is a
// different question and the one behind "it worked in testing and fell over in production". A
// gateway does not usually fail by getting slower. It fails by running out of something — pool
// slots, memory, sockets — and the failure arrives as timeouts that look exactly like a slow
// provider, which is the wrong thing to go and investigate.
//
// Three ceilings, in the order they actually bite:
//
//   the database pool   The smallest number here by a wide margin, and the least visible. Prisma
//                       defaults to a pool of `cores * 2 + 1` and QUEUES beyond it, so exhaustion
//                       is latency until the queue times out and then it is an error — and the
//                       error names the pool, in a log nobody reads during an incident.
//   memory              Slow, silent, and only visible over time. A leak is invisible in every
//                       other measurement in this directory because they all finish in seconds.
//   sockets             The one people expect, and usually the last to matter.
//
// ── Measured from outside wherever that is possible ───────────────────────────────────────────
//
// Connection counts come from `pg_stat_activity` — PostgreSQL's own view of who is connected —
// rather than from anything the gateway reports about itself. That is the whole discipline of this
// directory: a component's account of its own behaviour is exactly what fails when the behaviour
// is wrong. Memory is the exception and is taken from `/metrics`, because `process_resident_memory
// _bytes` is the operating system's number relayed by prom-client rather than an opinion of ours,
// and reading RSS for another process portably is otherwise a platform-by-platform mess.

import { execFileSync } from 'node:child_process';
import Redis from 'ioredis';
import { completionBody, setUpstream, startHarness, type Harness } from './gateway';
import { run } from './driver';

const PG_CONTAINER = process.env.BENCH_PG_CONTAINER ?? 'nexus-bench-pg';
const PG_URL = process.env.BENCH_DATABASE_URL
  ?? 'postgresql://nexus:nexus@127.0.0.1:55433/nexus';
const REDIS_URL = process.env.BENCH_REDIS_URL ?? '';

/**
 * Waves of sustained load in the memory scenario, and how long each one runs.
 *
 * Eight, not three, and the difference is the whole result rather than a matter of patience. The
 * first run of this file used three and reported a leak: +79 MB a wave, not coming back, exactly
 * the shape the check was written to catch. Eight waves show what those three actually were —
 * +169, +38, +1.3, +0.2, +3.9, -3.9, +5.7 — a process claiming its working set and then stopping.
 * Three waves is entirely inside the ramp, so it can only ever see a rise, and reports one whatever
 * the truth is.
 */
const WAVES = parseInt(process.env.BENCH_WAVES ?? '8', 10);
const WAVE_SECONDS = parseInt(process.env.BENCH_WAVE_SECONDS ?? '20', 10);
/** Concurrency during a wave. High enough to keep the gateway busy, low enough not to be the test. */
const WAVE_CONCURRENCY = parseInt(process.env.BENCH_WAVE_CONCURRENCY ?? '16', 10);
/** Idle gap between waves, for the heap to settle before it is read again. */
const SETTLE_SECONDS = parseInt(process.env.BENCH_SETTLE_SECONDS ?? '6', 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ── Reading the two independent counters ──────────────────────────────────────────────────────

/** Ask PostgreSQL something about itself. */
function psql(sql: string): string {
  return execFileSync('docker', [
    'exec', PG_CONTAINER, 'psql', '-U', 'nexus', '-d', 'nexus', '-tAc', sql,
  ], { encoding: 'utf8' }).trim();
}

/** How many connections PostgreSQL itself says are open to this database, excluding our probe. */
function pgConnections(): number {
  return parseInt(psql(
    "select count(*) from pg_stat_activity where datname = 'nexus' and pid <> pg_backend_pid()",
  ), 10);
}

/**
 * Transactions PostgreSQL has committed on this database.
 *
 * Here to stop the pool scenario passing vacuously. "The pool was never the limit" is only a
 * finding if the database was under some pressure to begin with — and this gateway resolves most
 * requests without touching it at all, so a sweep that never opened a transaction would report a
 * clean result about a component it never used. This is the difference between that and a PASS.
 */
function pgCommits(): number {
  return parseInt(psql("select xact_commit from pg_stat_database where datname = 'nexus'"), 10);
}

/**
 * Put both stores back to empty, so a second run measures the same thing as the first.
 *
 * Every other benchmark here is backed by a throwaway SQLite file inside a throwaway temp
 * directory, so it starts empty by construction. A real PostgreSQL does not: it OUTLIVES the run,
 * and the second run then finds the first run's API key row already present, generates no key, and
 * fails on a missing file with nothing to suggest the cause is yesterday's state.
 *
 * Redis needs the same treatment for a related reason that has bitten this directory before: the
 * key's HASH is cached there for five minutes, so a run inside that window authenticates against
 * the previous run's credential. See storeOps.ts, which found it first.
 */
function resetStores(): void {
  execFileSync('docker', [
    'exec', PG_CONTAINER, 'psql', '-U', 'nexus', '-d', 'nexus', '-c',
    'drop schema public cascade; create schema public;',
  ], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'ignore', env: { ...process.env, DATABASE_URL: PG_URL }, shell: process.platform === 'win32',
  });
}

interface Sample {
  rssBytes: number;
  /** Live objects after the last collection. */
  heapBytes: number;
  /** What V8 has RESERVED. RSS above this is native or unreturned pages, not JavaScript objects. */
  heapTotalBytes: number;
  /** Buffers and other off-heap allocations — where a socket or stream leak shows up. */
  externalBytes: number;
  handles: number;
  lagSeconds: number;
}

/** One reading of the gateway's own process metrics. */
async function sample(h: Harness): Promise<Sample | null> {
  const res = await fetch(`${h.gatewayUrl}/metrics`, {
    headers: { authorization: `Bearer ${h.metricsToken}` },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const num = (name: string): number => {
    const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.e+-]+)$`, 'm').exec(text);
    return m ? Number(m[1]) : NaN;
  };
  return {
    rssBytes:       num('process_resident_memory_bytes'),
    heapBytes:      num('nodejs_heap_size_used_bytes'),
    heapTotalBytes: num('nodejs_heap_size_total_bytes'),
    externalBytes:  num('nodejs_external_memory_bytes'),
    handles:        num('nodejs_active_handles_total'),
    lagSeconds:     num('nodejs_eventloop_lag_seconds'),
  };
}

// ── Scenario 1: does memory come back down? ───────────────────────────────────────────────────

/**
 * Three waves of load with idle gaps, reading RSS after each one has settled.
 *
 * The naive version of this test drives load once and reports "memory grew", which proves nothing:
 * a healthy Node process grows to fill whatever the collector has not yet needed to reclaim, and a
 * single upward number is the expected shape for both a leak and perfect health.
 *
 * The waves are what make it a test. Memory that returns to roughly the same place after each idle
 * gap is being reclaimed; memory that steps up once per wave and stays there is retained. That is a
 * difference a single reading cannot express.
 *
 * What this CANNOT do is prove the absence of a leak. A minute of traffic will not reveal something
 * that leaks a few bytes per request, and saying so is part of the result rather than a caveat
 * hidden underneath it.
 */
async function memoryOverWaves(h: Harness): Promise<void> {
  console.log('\n── Does memory come back down between waves? ─────────────────────────────────\n');

  const settled: Sample[] = [];
  const served: number[] = [];
  const before = await sample(h);
  if (!before) { console.log('  ✗ /metrics did not answer — nothing measured.'); return; }
  console.log(`  idle, before any load       rss ${mb(before.rssBytes)}   heap ${mb(before.heapBytes)}   handles ${before.handles}`);

  for (let wave = 1; wave <= WAVES; wave++) {
    const r = await run({
      url: `${h.gatewayUrl}/v1/chat/completions`,
      concurrency: WAVE_CONCURRENCY,
      requests: 1_000_000,
      maxSeconds: WAVE_SECONDS,
      warmup: 0,
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: (i: number) => completionBody(i),
    });
    await sleep(SETTLE_SECONDS * 1000);
    const s = await sample(h);
    if (!s) { console.log(`  ✗ /metrics stopped answering during wave ${wave}`); return; }
    settled.push(s);
    served.push(r.count);
    console.log(
      `  after wave ${wave} (${String(r.count).padStart(5)} reqs)   rss ${mb(s.rssBytes).padStart(8)}   ` +
      `heap ${mb(s.heapBytes).padStart(8)} of ${mb(s.heapTotalBytes).padStart(8)}   ` +
      `external ${mb(s.externalBytes).padStart(7)}   handles ${s.handles}`,
    );
  }

  const first = settled[0];
  const last  = settled[settled.length - 1];
  const handleGrowth = last.handles - first.handles;

  // Per REQUEST, not per wave. The waves do not serve equal amounts of work — the first is always
  // short because it is paying for JIT and pool warmup — so a per-wave figure mixes "how much it
  // retains" with "how much traffic that wave happened to carry", and the two move independently.
  const requestsAfterFirst = served.slice(1).reduce((a, b) => a + b, 0);
  const perThousand = requestsAfterFirst > 0
    ? ((last.rssBytes - first.rssBytes) / requestsAfterFirst) * 1000
    : NaN;

  // ── How this decides, and the version of it that was wrong ─────────────────────────────────
  //
  // The first attempt compared per-wave deltas and asked whether they were shrinking. It reported a
  // leak on healthy code, twice, for two different reasons — and both are worth keeping written
  // down because they are the obvious way to do this:
  //
  //   The waves do not carry equal traffic. One wave served 7,963 requests and the next 35,455, so
  //   a raw delta measures how busy a wave happened to be as much as what it retained.
  //
  //   The ramp dominates. A process claims its working set over the first few waves, and any window
  //   that includes them sees a rise whatever the truth is.
  //
  // So: throw the ramp away, and measure a RATE over what is left. Bytes per thousand requests,
  // across the second half of the run only. Measured, that separates cleanly — 0.06 MB/1k on
  // healthy code against 2.82 MB/1k with a deliberate 10 KB-per-request leak, a factor of about 47.
  const RAMP_WAVES = Math.ceil(settled.length / 2);
  const enoughWaves = settled.length >= 8;
  const rampEnd = settled[RAMP_WAVES - 1];
  const tailRequests = served.slice(RAMP_WAVES).reduce((a, b) => a + b, 0);
  const tailRateMbPer1k = tailRequests > 0
    ? ((last.rssBytes - rampEnd.rssBytes) / tailRequests) * 1000 / 1024 / 1024
    : NaN;

  // Set from BOTH sides, because a limit derived from only one of them is a guess about where the
  // other would have landed — and the first version of this line was exactly that guess, at 0.5,
  // which healthy code came within 13% of on its second run.
  //
  //   healthy, four runs   0.061 · 0.077 · 0.237 · 0.442 MB/1k   (a sevenfold spread: RSS moves in
  //                                                               allocator-sized steps, not smoothly)
  //   10 KB/request leak   2.82 MB/1k
  //
  // 1.2 is 2.7x above the worst healthy reading and 2.4x below the leaking one. A guard that trips
  // on noise gets switched off within a week, and one loose enough to fit the bug under it never
  // did anything at all.
  const LEAK_MB_PER_1K = 1.2;
  const deltas: number[] = [];
  for (let i = 1; i < settled.length; i++) deltas.push(settled[i].rssBytes - settled[i - 1].rssBytes);

  console.log('');
  console.log(`  RSS after wave 1 → wave ${settled.length}: ${mb(first.rssBytes)} → ${mb(last.rssBytes)}`);
  console.log(`  Per wave: ${deltas.map((d) => `${d >= 0 ? '+' : ''}${mb(d)}`).join('  ')}`);
  console.log(`  Normalised: ${perThousand >= 0 ? '+' : ''}${mb(perThousand)} per 1000 requests served after the first wave.`);
  console.log(`  V8 has reserved ${mb(last.heapTotalBytes)} of that; ${mb(last.rssBytes - last.heapTotalBytes)} is outside the JavaScript heap.`);

  console.log(`  After the ramp (waves ${RAMP_WAVES + 1}–${settled.length}): ` +
              `${tailRateMbPer1k >= 0 ? '+' : ''}${tailRateMbPer1k.toFixed(3)} MB per 1000 requests.`);

  if (!enoughWaves) {
    // SKIP as loudly as FAIL. Half of these waves are ramp, so a short run has nothing left to
    // measure and must not be read as a clean result.
    console.log(`\n  SKIP — ${settled.length} waves is not enough. Half of them are ramp, and what`);
    console.log(`    remains is too short to separate a plateau from a trend. Re-run with BENCH_WAVES=8.`);
  } else if (tailRateMbPer1k <= LEAK_MB_PER_1K) {
    console.log(`\n  ✓ ${tailRateMbPer1k.toFixed(3)} MB/1k is below the ${LEAK_MB_PER_1K} MB/1k limit — RSS has plateaued.`);
    console.log('    Retention would be proportional to traffic and would not flatten out.');
  } else {
    console.log(`\n  ✗ ${tailRateMbPer1k.toFixed(3)} MB/1k exceeds the ${LEAK_MB_PER_1K} MB/1k limit, AFTER the ramp.`);
    console.log('    That is growth proportional to traffic rather than a heap settling. Check the');
    console.log('    external column first — off-heap growth means buffers or sockets, not objects.');
  }

  if (handleGrowth > 5) {
    console.log(`  ✗ ${handleGrowth} more open handles than after the first wave — sockets or timers are not being released.`);
  } else {
    console.log(`  ✓ Handle count is stable (${first.handles} → ${last.handles}).`);
  }

  // The number an operator actually needs, and it is not the live heap. V8 sizes its reservation
  // from the memory it can see, not from what this process needs, so RSS settles far above the
  // working set — and a container sized from "it only uses 150 MB" gets killed by the allocator
  // rather than by a bug.
  console.log('');
  console.log(`  ▸ Size a container from ${mb(last.rssBytes)}, not from the ${mb(last.heapBytes)} of live heap.`);
  console.log(`    V8 reserved ${mb(last.heapTotalBytes)} because of the memory available to it, and RSS follows`);
  console.log('    the reservation. Pin it with --max-old-space-size to settle lower.');
  console.log('');
  console.log(`  ${WAVES} waves of ${WAVE_SECONDS}s. This catches retention visible at that scale.`);
  console.log('    It cannot prove the absence of a slow leak, and does not claim to.');
}

// ── Scenario 2: where is the database pool, and what does hitting it look like? ────────────────

/**
 * Raise concurrency and watch PostgreSQL's connection count stop rising.
 *
 * The plateau IS the pool: once every slot is held, more concurrent callers do not open more
 * connections, they queue for one. So the number is read from the database rather than from
 * configuration, which means it stays right when the default changes underneath us — and Prisma's
 * default is derived from the core count, so it is different on the machine that runs this than on
 * the machine that deploys it.
 *
 * What a caller sees at that point is the more useful half. Queueing is invisible until the queue
 * times out, and Prisma's timeout produces P2024, whose message names a connection pool — a phrase
 * that appears nowhere in a dashboard and means nothing to whoever is being paged.
 */
async function databasePoolCeiling(h: Harness): Promise<void> {
  console.log('\n── Where is the database connection pool, and what does exhaustion look like? ──\n');

  const idle = pgConnections();
  const commitsBefore = pgCommits();
  let requestsDriven = 0;
  console.log(`  connections while idle: ${idle}`);
  console.log('');
  console.log(`  ${'concurrency'.padStart(11)}  ${'pg conns'.padStart(8)}  ${'rps'.padStart(7)}  ${'p99 ms'.padStart(7)}  errors  statuses`);

  let peak = idle;
  for (const concurrency of [1, 2, 4, 8, 16, 32, 64]) {
    let observed = idle;
    // Sampled WHILE the load runs; afterwards the pool has already released everything and the
    // measurement would be of an idle gateway every time.
    const watcher = setInterval(() => {
      try { observed = Math.max(observed, pgConnections()); } catch { /* container busy */ }
    }, 200);

    const r = await run({
      url: `${h.gatewayUrl}/v1/chat/completions`,
      concurrency,
      requests: 1_000_000,
      maxSeconds: 6,
      warmup: 0,
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: (i: number) => completionBody(i),
    });
    clearInterval(watcher);
    peak = Math.max(peak, observed);
    requestsDriven += r.count;

    const p99 = r.sorted.length ? r.sorted[Math.floor(r.sorted.length * 0.99)] : NaN;
    const statuses = Object.entries(r.byStatus).map(([s, n]) => `${n}x${s}`).join(' ');
    console.log(
      `  ${String(concurrency).padStart(11)}  ${String(observed).padStart(8)}  ` +
      `${r.rps.toFixed(0).padStart(7)}  ${p99.toFixed(0).padStart(7)}  ${String(r.errors).padStart(6)}  ${statuses}`,
    );
  }

  const commits = pgCommits() - commitsBefore;
  console.log('');
  console.log(`  Peak connections PostgreSQL saw: ${peak} (its own max_connections is the other ceiling).`);
  console.log(`  Transactions committed during the sweep: ${commits} across ${requestsDriven} requests ` +
              `(${(commits / Math.max(1, requestsDriven)).toFixed(2)} per request).`);

  // Below this the sweep proved nothing about the pool, and must say so rather than pass.
  const MIN_COMMITS = 50;
  if (commits < MIN_COMMITS) {
    console.log('');
    console.log(`  SKIP — only ${commits} transactions were committed, so the pool was never asked for`);
    console.log('    anything. Nothing above is evidence about the pool; it is evidence that this');
    console.log('    request path does not use the database.');
    return;
  }

  // The gateway's own log is the only place the pool names itself, so it is worth grepping for
  // even though the counts above came from elsewhere.
  const log = h.log();
  const p2024 = (log.match(/P2024/g) ?? []).length;
  const poolTimeouts = (log.match(/Timed out fetching a new connection/g) ?? []).length;
  if (p2024 > 0 || poolTimeouts > 0) {
    console.log(`  ✗ ${Math.max(p2024, poolTimeouts)} pool timeouts (P2024) in the gateway log.`);
    console.log('    A caller saw these as a slow request and then an error that does not mention');
    console.log('    the database at all. This is the ceiling that gets misdiagnosed as the provider.');
  } else {
    console.log('  ✓ No pool timeouts at any concurrency tested — the pool was never the limit here.');
  }
}

// ── Scenario 3: what does a caller get at the ceiling? ────────────────────────────────────────

/**
 * The failure SHAPE, which matters more than the number.
 *
 * A ceiling reached cleanly is a 503 with a Retry-After: the caller backs off and comes back. A
 * ceiling reached badly is a dropped socket or a request that never returns, and those saturate a
 * client's own pool — one gateway at its limit then takes its callers down with it. The number is
 * hardware; the shape is a property of the code and is the part worth guarding.
 */
async function ceilingShape(h: Harness): Promise<void> {
  console.log('\n── At the ceiling, what does a caller actually receive? ───────────────────────\n');

  const r = await run({
    url: `${h.gatewayUrl}/v1/chat/completions`,
    concurrency: 128,
    requests: 1_000_000,
    maxSeconds: 8,
    warmup: 0,
    headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
    body: (i: number) => completionBody(i),
  });

  const statuses = Object.entries(r.byStatus).sort((a, b) => Number(b[1]) - Number(a[1]));
  console.log(`  128 concurrent callers for ${r.seconds.toFixed(1)}s → ${r.count} responses at ${r.rps.toFixed(0)} rps`);
  for (const [status, n] of statuses) {
    const share = ((n / r.count) * 100).toFixed(1);
    console.log(`    ${String(n).padStart(6)}  ${status.padEnd(4)}  ${share}%`);
  }
  console.log(`  transport failures and 5xx together: ${r.errors}`);

  // `errors` counts transport failures alongside 5xx, so a zero here is the strong statement: not
  // one caller was dropped rather than answered.
  if (r.errors === 0) {
    console.log('\n  ✓ Every caller got an answer. Nothing was dropped, nothing hung.');
  } else {
    console.log(`\n  ⚠ ${r.errors} of ${r.count} were a dropped connection or a 5xx rather than a refusal.`);
    console.log('    A refusal a client can act on; a dropped socket fills its pool and spreads.');
  }
}

(async () => {
  console.log('\nWhere the gateway stops, and what hitting the ceiling looks like from outside.');
  console.log('Connection counts come from pg_stat_activity, not from anything we report about ourselves.');

  resetStores();
  if (REDIS_URL) {
    const c = new Redis(REDIS_URL);
    await c.flushall();
    c.disconnect();
  }

  const h = await startHarness(3220, 3421, {
    databaseUrl: PG_URL,
    ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
  });
  try {
    // Zero upstream latency: this is about our own ceilings, and a slow mock would just measure the
    // mock — every worker would sit in the same wait instead of contending for anything of ours.
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    const only = process.env.BENCH_ONLY ?? '';
    if (!only || only === 'memory')  await memoryOverWaves(h);
    if (!only || only === 'pool')    await databasePoolCeiling(h);
    if (!only || only === 'ceiling') await ceilingShape(h);
  } finally {
    h.dispose();
  }
  console.log('');
  process.exit(0);
})();
