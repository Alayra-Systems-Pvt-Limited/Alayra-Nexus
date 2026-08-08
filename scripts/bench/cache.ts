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

// Does the response cache work, what does a hit save, and what does it cost when it misses?
//
//   docker run -d --name nexus-ops-redis -p 56379:6379 redis:7-alpine
//   npm run build && npm run bench:cache
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
//
// The response cache is the gateway's headline cost-saving feature and it has never been measured.
// Worse, it has been DOUBTED: the cache was reported from real use as writing and reading but never
// actually serving. A code audit disagreed, which settles nothing — a cache that works in the source
// and not in production is exactly the failure this benchmark exists to detect, and it can only be
// detected from outside.
//
// So the first thing here is not a latency number. It is a proof, taken from the upstream's own
// counter: send N requests of which only U are distinct, and count how many reached the provider. If
// the cache serves, the provider saw U. If it does not, it saw N. That is a fact about the running
// system that no amount of reading the source can produce, and it cannot pass by luck.
//
// ── Three questions, and the third is the one nobody publishes ────────────────────────────────
//
//   Does it serve?    the proof above. Correctness, before any performance claim.
//   What does a hit save?   a hit skips routing AND the provider, so its value is dominated by the
//                     provider latency it avoids.
//   What does a MISS cost?  every request pays a cache lookup, including the ones that miss. On a
//                     workload that rarely repeats itself, that is pure tax with nothing back. The
//                     honest question about a cache is not "how fast is a hit" — it is "at what hit
//                     rate does this stop costing me money", and answering it needs the tax measured.
//
// ── The upstream latency is a CHOICE, and it decides the answer ───────────────────────────────
//
// Every other benchmark here runs the mock at 0 ms, which is right when measuring the gateway's own
// overhead: real provider latency is their network and their load, and it would swamp the number
// that belongs to us.
//
// It is exactly wrong here. A cache's entire value is the provider call it avoids, so at 0 ms this
// script would measure a cache saving nothing and report that the feature is pointless. At 2,000 ms
// it would report a miracle. Neither is a finding — both are restatements of the constant.
//
// So the constant is named, defaulted to something defensible, and printed with every result:
// CACHE_UPSTREAM_MS, default 200 ms, which is a fast real completion rather than a slow one. Every
// saving figure below scales with it, and a reader who thinks their provider is slower can turn the
// knob and re-run rather than argue with the table.

import { execFileSync } from 'node:child_process';
import { p50, p95, p99, ms, run, type RunResult } from './driver';
import { completionBody, setUpstream, startHarness, type Harness } from './gateway';
import { workloadBody } from './cacheWorkload';

const REDIS_CONTAINER = process.env.OPS_REDIS_CONTAINER ?? 'nexus-ops-redis';
const REDIS_PORT   = parseInt(process.env.OPS_REDIS_PORT ?? '56379', 10);
const REQUESTS     = parseInt(process.env.CACHE_REQUESTS ?? '400', 10);
const CONCURRENCY  = parseInt(process.env.CACHE_CONCURRENCY ?? '8', 10);
const UPSTREAM_MS  = parseInt(process.env.CACHE_UPSTREAM_MS ?? '200', 10);
/** How many distinct prompts the "repeat" traffic draws from. See `bodyFactory`. */
const HOT_SET      = parseInt(process.env.CACHE_HOT ?? '20', 10);
const TTL_SECONDS  = parseInt(process.env.CACHE_TTL ?? '3600', 10);

/** The mock's fixed usage, from mockUpstream.mjs. Every completion reports exactly this. */
const PROMPT_TOKENS = 7;
const OUTPUT_TOKENS = 5;
/** Registry prices the harness provisions, per million tokens. See gateway.ts:provisionGateway. */
const INPUT_PER_1M  = 3;
const OUTPUT_PER_1M = 15;

/** What one uncached completion costs at the harness's prices — the value of a single hit. */
const USD_PER_CALL =
  (PROMPT_TOKENS / 1e6) * INPUT_PER_1M + (OUTPUT_TOKENS / 1e6) * OUTPUT_PER_1M;

const sleep = (msec: number): Promise<void> => new Promise((r) => setTimeout(r, msec));

interface MockStats { requests: number; byStatus: Record<string, number> }
interface CacheStats {
  config: { enabled: boolean; ttlSeconds: number };
  entries: number;
  recent: { hits: number; requests: number; hitRate: number; savedUsd: number };
}

async function mockStats(mockUrl: string): Promise<MockStats> {
  return await (await fetch(`${mockUrl}/__stats`)).json() as MockStats;
}

async function resetMock(mockUrl: string): Promise<void> {
  await fetch(`${mockUrl}/__reset`, { method: 'POST' });
}

async function setCache(h: Harness, enabled: boolean): Promise<void> {
  const r = await fetch(`${h.gatewayUrl}/admin/settings/cache`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    body: JSON.stringify({ enabled, ttlSeconds: TTL_SECONDS }),
  });
  if (!r.ok) throw new Error(`could not set the cache config: HTTP ${r.status}`);
}

async function purgeCache(h: Harness): Promise<void> {
  await fetch(`${h.gatewayUrl}/admin/cache/purge`, {
    method: 'POST', headers: { authorization: `Bearer ${h.adminToken}` },
  });
}

async function cacheStats(h: Harness): Promise<CacheStats> {
  return await (await fetch(`${h.gatewayUrl}/admin/cache/stats`, {
    headers: { authorization: `Bearer ${h.adminToken}` },
  })).json() as CacheStats;
}

/** Send the hot set once so it is in the cache before anything is measured. */
async function primeHotSet(h: Harness): Promise<void> {
  for (let i = 0; i < HOT_SET; i++) {
    await (await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(completionBody(i)),
    })).text();
  }
}

/** One completion, returning the cache header the gateway stamped on it. */
async function probeCacheHeader(h: Harness, n: number): Promise<string | null> {
  const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(completionBody(n)),
  });
  await r.text();
  return r.headers.get('x-nexus-cache');
}

// ── Phase 1: does the cache actually serve? ───────────────────────────────────────────────────

async function proveItServes(h: Harness): Promise<{ serving: boolean; avoided: number }> {
  console.log('── Does the cache serve at all? ────────────────────────────────────────────────\n');
  console.log('Counted at the UPSTREAM, not in our own logs: a cache that believes it is serving');
  console.log('while the provider still sees every request is precisely the failure being ruled out.\n');

  const ROUNDS = 5;
  const results: { label: string; sent: number; upstream: number }[] = [];

  for (const enabled of [false, true]) {
    await setCache(h, enabled);
    await purgeCache(h);
    await resetMock(h.mockUrl);

    // The same single prompt, ROUNDS times. With the cache off every one must reach the provider;
    // with it on, only the first can.
    for (let i = 0; i < ROUNDS; i++) await probeCacheHeader(h, 42);

    const after = await mockStats(h.mockUrl);
    results.push({ label: enabled ? 'cache ON ' : 'cache OFF', sent: ROUNDS, upstream: after.requests });
  }

  console.log('  config      requests sent   reached the provider');
  for (const r of results) {
    console.log(`  ${r.label}   ${String(r.sent).padStart(13)}   ${String(r.upstream).padStart(20)}`);
  }

  const off = results[0]!;
  const on  = results[1]!;
  const serving = on.upstream < off.upstream && on.upstream === 1;

  // The header is a second, independent witness. If the counter and the header disagree, something
  // is stamping "hit" on a request that was served by the provider, which is worse than not caching.
  // One more request, and (if the cache works) one more hit for the ledger to account for.
  const header = await probeCacheHeader(h, 42);
  const avoided = (off.sent - off.upstream) + (on.sent - on.upstream) + (header === 'hit' ? 1 : 0);

  console.log('');
  if (serving && header === 'hit') {
    console.log(`  ✓ SERVING. ${off.upstream} identical requests reached the provider uncached, ${on.upstream} cached,`);
    console.log('    and a repeat request comes back stamped X-Nexus-Cache: hit.');
  } else if (serving) {
    console.log(`  ⚠ The provider count says the cache IS serving (${on.upstream} of ${ROUNDS}), but the`);
    console.log(`    response header says "${header ?? 'nothing'}" rather than "hit". One of the two is wrong.`);
  } else {
    console.log(`  ✗ NOT SERVING. ${on.upstream} of ${ROUNDS} identical requests still reached the provider`);
    console.log('    with the cache enabled. Everything below this line is meaningless; fix this first.');
  }
  console.log('');
  return { serving, avoided };
}

// ── Phase 2: what a hit saves, and what a miss costs ──────────────────────────────────────────

interface Cell {
  label: string;
  result: RunResult;
  upstream: number;
  /** Requests that never reached the provider, measured phase and warm phase separately. */
  avoided: number;
  avoidedWarm: number;
}

/**
 * One cell: configure the cache, warm, then measure.
 *
 * The warmup is a SEPARATE driver run rather than the driver's own `warmup` option, for one reason
 * that matters to the arithmetic: the provider's counter has to be zeroed between warming and
 * measuring. Left inside `run()`, warmup requests would reach the upstream, be counted there, and
 * then be subtracted from a measured request total that never included them — which at a 0% repeat
 * rate produces a NEGATIVE "calls avoided" and, at every other rate, a quietly overstated one.
 *
 * Both runs share ONE body generator. A fresh generator per run would restart its unique counter,
 * so the measured run would re-send the warm run's "unique" prompts — and every one of them would
 * be a cache hit recorded as a miss. That is the single most dangerous mistake available here: it
 * would inflate the headline number in our own favour and look entirely plausible.
 */
async function measure(h: Harness, label: string, enabled: boolean, repeatRate: number): Promise<Cell> {
  await setCache(h, enabled);
  await purgeCache(h);
  if (enabled && repeatRate > 0) await primeHotSet(h);

  const body = workloadBody(repeatRate, HOT_SET);
  const common = {
    url:         `${h.gatewayUrl}/v1/chat/completions`,
    concurrency: CONCURRENCY,
    headers:     { authorization: `Bearer ${h.apiKey}` },
    body,
  };

  // Discarded for LATENCY: JIT, TCP establishment, the first-call cost of anything lazy. Its hits
  // are still counted, because the gateway's ledger counts them and the reconciliation at the end
  // compares against that ledger. Warm requests that vanish from our arithmetic but not from the
  // gateway's would show up there as an unexplained surplus and cast doubt on a check that is fine.
  const warmCount = Math.min(40, REQUESTS);
  await resetMock(h.mockUrl);
  await run({ ...common, requests: warmCount, maxSeconds: 20 });
  const avoidedWarm = warmCount - (await mockStats(h.mockUrl)).requests;

  await resetMock(h.mockUrl);
  const result = await run({ ...common, requests: REQUESTS, maxSeconds: 120 });
  const upstream = (await mockStats(h.mockUrl)).requests;

  return { label, result, upstream, avoided: result.count - upstream, avoidedWarm };
}

/**
 * What the cache lookup costs a request that will never hit.
 *
 * Measured in its own experiment, with the upstream at 0 ms, and that is the whole point. The first
 * version read this off the 200 ms cells and got −6.0 ms on one run and +5.7 ms on the next: a
 * single-digit effect cannot be resolved against a 200 ms constant with a few hundred samples, and
 * the two runs disagreed about whether the cache makes misses slower or faster. A benchmark that
 * says different things on consecutive runs is worse than one that says nothing.
 *
 * With the provider answering instantly the gateway's own work is most of the latency, and one
 * Redis round trip is a visible share of it. Combining the two conditions is sound because the tax
 * does not depend on the upstream — it is a lookup that happens before routing, and it costs the
 * same whether the provider then takes 0 ms or 2,000.
 *
 * Cells are INTERLEAVED and repeated. Three runs of A followed by three of B would confound the
 * difference with anything that drifts over the run — a background process, thermal throttling, the
 * database growing. Alternating them spreads that across both.
 */
async function measureTax(h: Harness): Promise<{ taxMs: number; offMs: number; onMs: number; spreadMs: number }> {
  const REPEATS = 3;
  const offs: number[] = [];
  const ons:  number[] = [];

  for (let i = 0; i < REPEATS; i++) {
    offs.push(p50((await measure(h, 'tax: off', false, 0)).result.sorted));
    ons.push(p50((await measure(h, 'tax: on',  true,  0)).result.sorted));
  }

  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const offMs = median(offs);
  const onMs  = median(ons);
  // How much the same configuration varied between its own repeats. A difference smaller than this
  // is not a finding, and printing it next to the answer is what lets a reader see that for
  // themselves rather than take the claim on trust.
  const spreadMs = Math.max(Math.max(...offs) - Math.min(...offs), Math.max(...ons) - Math.min(...ons));

  return { taxMs: onMs - offMs, offMs, onMs, spreadMs };
}

/** Markdown, like the rest of the suite, so a result pastes into docs without hand-formatting. */
const CELL_HEAD =
  '| scenario | p50 ms | p95 ms | p99 ms | RPS | provider calls | errors |\n|---|---|---|---|---|---|---|';

function printCells(cells: Cell[]): void {
  console.log(CELL_HEAD);
  for (const { label, result: r, upstream } of cells) {
    console.log(
      `| ${label} | ${ms(p50(r.sorted))} | ${ms(p95(r.sorted))} | ${ms(p99(r.sorted))} | ` +
      `${r.rps.toFixed(0)} | ${upstream} | ${r.errors} |`,
    );
  }
}

async function main(): Promise<void> {
  const redisUrl = `redis://127.0.0.1:${REDIS_PORT}/0`;

  console.log('');
  console.log(`Upstream latency ${UPSTREAM_MS} ms · ${REQUESTS} requests · ${CONCURRENCY} workers · hot set ${HOT_SET}`);
  console.log(`Cache in ${process.env.OPS_REDIS_URL ?? `Redis at ${REDIS_CONTAINER}:${REDIS_PORT}`}, which is where it lives in production.`);
  console.log('');

  // Empty it first, for the reason storeOps.ts hit and documented: settings live in Redis for five
  // minutes and the API key's hash is one of them. A second run inside that window boots against the
  // PREVIOUS run's hash, concludes a key already exists, never writes one, and dies reading a file
  // that was never created. The gateway is right; the benchmark was handing it stale state.
  execFileSync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'flushall'], { encoding: 'utf8' });

  const h = await startHarness(3210, 3401, { redisUrl });

  try {
    // 0 ms while proving correctness — Phase 1 counts requests and cares nothing for time, and a
    // 200 ms upstream would make it needlessly slow.
    await setUpstream(h.mockUrl, { latencyMs: 0 });
    const phase1 = await proveItServes(h);

    await setUpstream(h.mockUrl, { latencyMs: UPSTREAM_MS });

    console.log('── What a hit saves, and what a miss costs ─────────────────────────────────────\n');

    const cells: Cell[] = [];
    cells.push(await measure(h, 'cache OFF',             false, 0)); // baseline: everything goes upstream
    cells.push(await measure(h, 'cache ON, 0% repeat',   true,  0)); // no request hits
    cells.push(await measure(h, 'cache ON, 100% repeat', true,  1)); // the ceiling: nothing reaches the provider
    printCells(cells);

    const off  = cells[0]!;
    const best = cells[2]!;
    const savedMs = p50(off.result.sorted) - p50(best.result.sorted);

    console.log('');
    console.log(`  A hit saves ${ms(savedMs)} ms at p50 — most of it the ${UPSTREAM_MS} ms provider call it did not make.`);
    console.log(`  It also lifts throughput from ${off.result.rps.toFixed(0)} to ${best.result.rps.toFixed(0)} RPS, which is the same fact stated`);
    console.log('  in the unit an operator pays in.');
    console.log('');
    console.log('  Do NOT read the miss cost off the middle row. The two 0%-repeat rows differ by a');
    console.log('  few ms either way, which is variance, not a measurement — it needs its own run.');

    console.log('');
    console.log('── What a miss costs, measured where it is visible ─────────────────────────────\n');
    console.log('  Upstream at 0 ms, three interleaved repeats. A lookup worth single-digit ms cannot');
    console.log(`  be resolved against the ${UPSTREAM_MS} ms constant above, so it is measured without it.\n`);

    await setUpstream(h.mockUrl, { latencyMs: 0 });
    const tax = await measureTax(h);
    await setUpstream(h.mockUrl, { latencyMs: UPSTREAM_MS });

    console.log(`  cache OFF, p50                 ${ms(tax.offMs)} ms`);
    console.log(`  cache ON and never hitting     ${ms(tax.onMs)} ms`);
    console.log(`  the lookup tax                 ${ms(tax.taxMs)} ms`);
    console.log(`  spread within one config       ${ms(tax.spreadMs)} ms   (how much repeats disagreed)`);
    console.log('');
    if (Math.abs(tax.taxMs) > tax.spreadMs) {
      // The number an operator actually needs: below this hit rate the cache is a net loss on
      // latency. The tax is upstream-independent, so combining it with the saving above is sound.
      const breakEven = tax.taxMs / (savedMs + tax.taxMs);
      console.log(`  The tax is larger than the run-to-run spread, so it is real: ${ms(tax.taxMs)} ms on EVERY`);
      console.log('  request, hit or miss.');
      console.log(`  Against a ${ms(savedMs)} ms saving per hit, the cache breaks even on latency at about a`);
      console.log(`  ${(breakEven * 100).toFixed(2)}% hit rate. Below that it makes the average request slower.`);
      console.log(`  That threshold is this low only because the provider takes ${UPSTREAM_MS} ms. A fast`);
      console.log('  provider raises it, and is the case where enabling the cache needs thought.');
    } else {
      console.log(`  The tax is within the ${ms(tax.spreadMs)} ms spread of repeats of the SAME configuration, so`);
      console.log('  this run cannot separate it from noise. Read it as "smaller than we can measure');
      console.log('  here", never as zero — and raise CACHE_REQUESTS if you need a tighter bound.');
    }

    console.log('');
    console.log('── The sweep: what happens between the two extremes ────────────────────────────\n');

    const sweep: { rate: number; cell: Cell }[] = [];
    for (const rate of [0, 0.25, 0.5, 0.75, 1]) {
      sweep.push({ rate, cell: await measure(h, `${(rate * 100).toFixed(0)}% repeat`, true, rate) });
    }

    console.log('  repeat rate   p50 ms   p95 ms      rps   provider calls   avoided   saved USD');
    for (const s of sweep) {
      const r = s.cell.result;
      console.log(
        `  ${`${(s.rate * 100).toFixed(0)}%`.padStart(11)}` +
        `${ms(p50(r.sorted)).padStart(9)}${ms(p95(r.sorted)).padStart(9)}${r.rps.toFixed(0).padStart(9)}` +
        `${String(s.cell.upstream).padStart(17)}${String(s.cell.avoided).padStart(10)}` +
        `${(s.cell.avoided * USD_PER_CALL).toFixed(4).padStart(12)}`,
      );
    }

    console.log('');
    console.log('  "avoided" is measured at the provider, not claimed by us: requests sent minus');
    console.log('  requests the upstream received. It is the only figure here that cannot be wrong');
    console.log('  in our favour without the mock also being wrong.');
    console.log('');
    console.log('  Read the RPS column, not the p50 one. p50 moves in a step rather than a curve —');
    console.log('  below a 50% hit rate the median request is a miss and reads as though the cache');
    console.log('  did nothing, above it the median is a hit and reads as though the cache did');
    console.log('  everything. Neither is true; the median is just picking a side of a two-humped');
    console.log('  distribution. p95 barely moves at all until the very top, because the tail is');
    console.log('  made entirely of misses and a cache cannot make a miss faster. What improves');
    console.log('  smoothly and honestly with the hit rate is throughput and money, which is what');
    console.log('  a cache is actually for.');

    // ── Does the gateway's own accounting agree with the provider's counter? ──────────────────
    //
    // `savedUsd` is what the dashboard shows an operator, and it comes from OUR ledger. The mock's
    // counter is independent of it. If the two disagree, the dashboard is telling somebody a number
    // about money that is not true — which matters more than any latency figure above.
    //
    // The comparison has to be like for like, and the obvious version is not. The ledger spans the
    // WHOLE RUN inside its window; any single cell is a fraction of that. Printing one against the
    // other would put two numbers of different scope side by side and invite a reader to conclude
    // something from the gap, which is the same mistake as counting a Lua script's internal calls
    // as network round trips. So every hit-producing request in this process is accumulated —
    // correctness phase, warm phases, measured phases — and the total is what gets compared.
    //
    // Priming contributes nothing: it runs straight after a purge, so every one of its requests is
    // a miss by construction.
    const allCells = [...cells, ...sweep.map((s) => s.cell)];
    const expectedHits = phase1.avoided + allCells.reduce((n, c) => n + c.avoided + c.avoidedWarm, 0);
    const expectedUsd  = expectedHits * USD_PER_CALL;

    // The ledger is written fire-and-forget so a response is never blocked by accounting. Give the
    // last few writes a moment to land, or this reconciles against a ledger still catching up.
    await sleep(2_000);
    const finalStats = await cacheStats(h);
    const reportedHits = finalStats.recent.hits;
    const reportedUsd  = finalStats.recent.savedUsd;

    console.log('');
    console.log('── Does our accounting agree with the provider\'s counter? ──────────────────────\n');
    console.log('  Every hit this run produced, against what the dashboard says it produced.\n');
    console.log(`  hits, counted at the provider   ${expectedHits}   (requests sent minus requests received)`);
    console.log(`  hits, recorded by the gateway   ${reportedHits}`);
    console.log(`  savedUsd implied by the count   ${expectedUsd.toFixed(4)}   at ${INPUT_PER_1M}/${OUTPUT_PER_1M} per 1M tokens`);
    console.log(`  savedUsd shown on the dashboard ${reportedUsd.toFixed(4)}`);
    console.log('');

    const hitGap = reportedHits - expectedHits;
    const usdGap = Math.abs(reportedUsd - expectedUsd);
    if (reportedHits === 0 && expectedHits > 0) {
      console.log('  ✗ The provider was spared work the gateway never recorded. The dashboard is');
      console.log('    understating the feature it exists to sell.');
      process.exitCode = 1;
    } else if (hitGap !== 0) {
      console.log(`  ⚠ Off by ${hitGap > 0 ? '+' : ''}${hitGap} hits. Small and positive is usually a stray request this`);
      console.log('    script did not account for; anything else means the ledger and the provider');
      console.log('    disagree about what happened, and the dashboard is the one that can be wrong.');
    } else if (usdGap > 1e-6) {
      console.log(`  ⚠ Hit counts agree exactly but the money does not (off by ${usdGap.toFixed(6)}).`);
      console.log('    The pricing applied to a cache hit is not the pricing this script expects.');
    } else {
      console.log('  ✓ Exact. Every hit the provider was spared is on the dashboard, priced correctly.');
    }

    console.log('');
    console.log('── What these numbers are not ──────────────────────────────────────────────────\n');
    console.log(`  · Every saving scales with CACHE_UPSTREAM_MS (${UPSTREAM_MS} ms here). A slower provider`);
    console.log('    makes the cache look better and a faster one worse, and neither is news.');
    console.log('  · The mock returns a fixed 12-token response. Real responses are longer and cost');
    console.log('    more, so the dollar column is a floor rather than an estimate.');
    console.log('  · This is EXACT-match caching. A hit is the same answer the model gave before, so');
    console.log('    the saving carries no correctness risk. That stops being true the moment a');
    console.log('    semantic cache is added, and the accounting has to change with it: a semantic');
    console.log('    hit costs an embedding call, so the honest figure becomes saved minus that.');
    console.log(`  · Latency is from ${CONCURRENCY} closed-loop workers on this machine. See scripts/bench/k6`);
    console.log('    for the open-loop numbers, which are the ones worth publishing.');
    console.log('');

    // A cache that does not serve is the one failure that makes every number above meaningless, so
    // it is the one that fails the run rather than merely printing a warning.
    if (!phase1.serving) process.exitCode = 1;
  } finally {
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
