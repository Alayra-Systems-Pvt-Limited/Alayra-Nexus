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

// What does putting Nexus in front of a provider cost?
//
//   npm run build && npm run bench:overhead
//
// The first question anyone asks about a gateway, and the only one with a defensible answer, because
// it is a DIFFERENCE rather than an absolute. Real provider latency is their network and their load;
// nothing measured here would survive contact with it. So the same load runs twice — straight at a
// mock upstream, then through a gateway pointed at that same mock — and the gap between them is the
// only number that belongs to us.
//
// ── Read the direct row first ─────────────────────────────────────────────────────────────────
//
// It is the floor: TCP, HTTP parsing, JSON, the event loop, and this machine. If that row is slow,
// every other row is slow for the same reason and the overhead column is still meaningful. Anyone
// re-running this on their own hardware should compare the GAP, never the absolute.
//
// ── Every throughput figure carries a verdict ─────────────────────────────────────────────────
//
// The zero-latency direct run establishes what this driver and this machine can push with nothing
// in the way, and every gateway result is judged against it. A number sitting on that ceiling
// describes the harness rather than the product, and is labelled instead of being reported as a
// finding. LiteLLM's published 1,035 → 1,170 RPS across doubled hardware is what that failure looks
// like when nobody checks.
//
// The other ceiling is arithmetic: 8 workers against a 200 ms upstream cannot exceed 40 RPS, so
// reaching it is the CORRECT outcome and is labelled LATENCY-BOUND rather than treated as a limit
// we imposed.

import { startHarness, setUpstream, COMPLETION_BODY } from './gateway';
import { run, saturationVerdict, p50, p95, p99, ms, TABLE_HEAD, tableRow, type RunResult } from './driver';

/** Concurrency levels to sweep. Low is latency-shaped; high is throughput-shaped. */
const LEVELS = [1, 8, 32];
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 3_000);
const WARMUP   = Number(process.env.BENCH_WARMUP   ?? 500);
/** Wall-clock cap per cell. See RunOptions.maxSeconds — without it one cell dominates the sweep. */
const MAX_SECONDS = Number(process.env.BENCH_MAX_SECONDS ?? 20);

/** Upstream latencies to test at. 0 isolates our cost; 200ms is what a real model feels like. */
const UPSTREAM_LATENCIES = [0, 200];   // 0 FIRST: it establishes the driver ceiling the rest are judged against

async function main(): Promise<void> {
  console.log('\n── Proxy overhead ──\n');
  console.log(`  up to ${REQUESTS.toLocaleString()} requests or ${MAX_SECONDS}s per cell, concurrency ${LEVELS.join(' / ')}`);

  const h = await startHarness();
  const rows: string[] = [];
  const notes: string[] = [];
  /** Driver ceiling per concurrency, measured on the zero-latency pass. */
  const ceilings: Record<number, number> = {};

  try {
    for (const upstreamMs of UPSTREAM_LATENCIES) {
      await setUpstream(h.mockUrl, { latencyMs: upstreamMs, failRate: 0, rate429: 0, status: 200 });
      console.log(`\n  upstream latency ${upstreamMs} ms\n`);
      console.log(`  ${TABLE_HEAD.split('\n')[0]}`);

      for (const concurrency of LEVELS) {
        // Direct first: the floor this machine can do, and the driver's ceiling at this concurrency.
        const direct: RunResult = await run({
          url: `${h.mockUrl}/v1/chat/completions`,
          concurrency, requests: REQUESTS, warmup: Math.min(WARMUP, 200), maxSeconds: MAX_SECONDS,
          body: { model: 'bench-model-1', messages: [{ role: 'user', content: 'Benchmark request.' }] },
        });

        const through: RunResult = await run({
          url: `${h.gatewayUrl}/v1/chat/completions`,
          concurrency, requests: REQUESTS, warmup: Math.min(WARMUP, 200), maxSeconds: MAX_SECONDS,
          body: COMPLETION_BODY,
          headers: { authorization: `Bearer ${h.apiKey}` },
        });

        // The ceiling is the ZERO-latency direct run at this concurrency — what the driver and this
        // machine can do with nothing in the way. Comparing against the same-latency direct run
        // instead would flag the good outcome as a problem; see saturationVerdict.
        ceilings[concurrency] ??= upstreamMs === 0 ? direct.rps : Infinity;
        const verdict = saturationVerdict(through.rps, ceilings[concurrency], concurrency, upstreamMs);
        const overhead = {
          p50: p50(through.sorted) - p50(direct.sorted),
          p95: p95(through.sorted) - p95(direct.sorted),
          p99: p99(through.sorted) - p99(direct.sorted),
        };

        rows.push(tableRow(`direct, upstream ${upstreamMs}ms, c=${concurrency}`, direct));
        rows.push(tableRow(`nexus,  upstream ${upstreamMs}ms, c=${concurrency}`, through));
        rows.push(
          `| **overhead, upstream ${upstreamMs}ms, c=${concurrency}** | **${ms(overhead.p50)}** | ` +
          `**${ms(overhead.p95)}** | **${ms(overhead.p99)}** | — | ${through.errors} |`);

        console.log(`  ${tableRow(`direct  c=${concurrency}`, direct)}`);
        console.log(`  ${tableRow(`nexus   c=${concurrency}`, through)}`);
        console.log(`  → overhead p50 ${ms(overhead.p50)} ms · p95 ${ms(overhead.p95)} ms · p99 ${ms(overhead.p99)} ms`);
        console.log(`    ${verdict.note}\n`);

        if (!verdict.trustworthy) {
          notes.push(`upstream ${upstreamMs}ms, c=${concurrency}: ${verdict.note}`);
        }

        // Subtracting one latency from another only means "overhead" while BOTH sides are keeping
        // up. Once the gateway is at its own ceiling its requests are queueing, and the difference
        // becomes queue depth — a number that grows with concurrency and describes saturation
        // rather than per-request cost. Said out loud, because a 72 ms "overhead" that is really a
        // queue is exactly the sort of figure that gets quoted without its context.
        // `concurrency > 1` matters: with a single worker there is never more than one request in
        // flight, so there is nothing to queue and the whole difference IS per-request cost, however
        // far apart the two throughputs look. Flagging c=1 would discredit the one row that needs no
        // caveat at all.
        if (concurrency > 1 && through.rps < direct.rps * 0.5) {
          notes.push(
            `upstream ${upstreamMs}ms, c=${concurrency}: the gateway is SATURATED here ` +
            `(${through.rps.toFixed(0)} vs ${direct.rps.toFixed(0)} RPS direct) — the overhead row is ` +
            'queueing, not per-request cost. Read the low-concurrency rows for overhead, and this row for capacity.');
        }
        if (through.errors > 0) {
          notes.push(`upstream ${upstreamMs}ms, c=${concurrency}: ${through.errors} errored — ${JSON.stringify(through.byStatus)}`);
        }
      }
    }

    // The whole table, ready to paste. Printed at the end rather than streamed so a copy is not
    // interleaved with progress output.
    console.log('\n── docs/BENCHMARKS.md ──\n');
    console.log(TABLE_HEAD);
    for (const r of rows) console.log(r);
    if (notes.length > 0) {
      console.log('\nCaveats measured during this run:');
      for (const n of notes) console.log(`- ${n}`);
    }
    console.log('');
  } finally {
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
