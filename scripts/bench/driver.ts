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

// The load driver every benchmark scenario runs on.
//
// ── The mistake this is built to avoid ────────────────────────────────────────────────────────
//
// LiteLLM's published benchmark reports 1,035 RPS on two instances and 1,170 on four — doubling the
// hardware and halving the latency bought 13% more throughput. With a closed-loop generator that is
// not possible: throughput is workers ÷ latency, so 1,000 workers at 100 ms is around 10,000 RPS,
// not 1,170. Something other than the gateway was the limit in both runs, which means their RPS
// figure measures their test rig rather than their product.
//
// That is an easy mistake to repeat and an embarrassing one to publish, so this driver refuses to
// report a throughput number without first proving it can exceed it. `calibrate()` runs the same
// load against the mock upstream directly; if a gateway result lands near the driver's own ceiling,
// `saturationVerdict()` says so instead of letting the number stand as a finding.
//
// ── Closed loop, on purpose ───────────────────────────────────────────────────────────────────
//
// N workers, each sending one request and waiting for it before sending the next — the shape of a
// real client with a connection pool. An open-loop generator (fire at a fixed rate regardless of
// responses) measures something real too, but it queues without bound once the target slows, and
// then reports a latency that is mostly time spent in its own backlog.
//
// ── node:http rather than a client library ────────────────────────────────────────────────────
//
// No new dependency. Partly hygiene — this repository keeps its dependency tree small and just spent
// a release clearing advisories that arrived through it — and partly that a driver built on an HTTP
// client is also measuring that client. `http.Agent` gives the two controls that actually matter for
// benchmark accuracy, keep-alive and socket count, with nothing underneath them to explain.

import http from 'node:http';

export interface RunResult {
  /** Every measured latency in ms, ascending. */
  sorted: number[];
  count: number;
  /** Transport failures and 5xx together — the caller usually wants both as "did not work". */
  errors: number;
  /** Wall-clock seconds of the measured phase. */
  seconds: number;
  rps: number;
  byStatus: Record<number, number>;
}

export interface RunOptions {
  url: string;
  /** Concurrent workers. Each holds one in-flight request at a time. */
  concurrency: number;
  /** Requests to measure, after warmup. */
  requests: number;
  /** Requests to send and discard before measuring. */
  warmup?: number;
  /**
   * Stop measuring after this many seconds, even with requests left.
   *
   * A fixed request count makes cells take wildly different wall times: 1 worker against a 200 ms
   * upstream is 5 RPS by arithmetic, so 1,500 requests is five minutes for one cell, while the same
   * count at 32 workers and 0 ms finishes in seconds. Left alone, a sweep spends nearly all of its
   * time on its least interesting cell.
   *
   * Truncating is safe here because percentiles do not need a particular COUNT, they need enough
   * samples — and every cell reports the count it actually achieved, so a short one is visible
   * rather than silently averaged in.
   */
  maxSeconds?: number;
  body?: unknown;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
}

/** One request. Resolves with its latency and status; never rejects, so one failure cannot end a run. */
function once(
  url: URL, method: string, headers: Record<string, string>, payload: string | undefined, agent: http.Agent,
): Promise<{ ms: number; status: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const req = http.request(
      {
        agent,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload === undefined
          ? headers
          : { ...headers, 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        // The body MUST be consumed or the socket is never returned to the pool, and the run quietly
        // degrades into one connection per request — which shows up as a p99 climbing for no reason
        // that exists in the target. `resume()` discards it without building a string.
        res.resume();
        res.on('end', () => resolve({ ms: performance.now() - started, status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', () => resolve({ ms: performance.now() - started, status: 0 }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Percentiles from the sorted array, nearest-rank.
 *
 * Exact rather than an estimator such as HDRHistogram: these runs hold a few hundred thousand
 * numbers at most, which costs nothing, and an approximate p99 is the one figure in a benchmark
 * that nobody reading it can check.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export const p50 = (s: number[]): number => percentile(s, 50);
export const p95 = (s: number[]): number => percentile(s, 95);
export const p99 = (s: number[]): number => percentile(s, 99);

/** Drive `url` with `concurrency` workers until `requests` have been measured. */
export async function run(opts: RunOptions): Promise<RunResult> {
  const { url, concurrency, requests, warmup = 0, maxSeconds = Infinity, body, headers = {}, method = 'POST' } = opts;
  const target = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const hdrs: Record<string, string> = { 'content-type': 'application/json', ...headers };

  // maxSockets === concurrency so no worker ever queues for a socket. Queueing inside the driver is
  // indistinguishable, in the numbers, from the target being slow.
  const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });

  const latencies: number[] = [];
  const byStatus: Record<number, number> = {};
  let issued = 0;
  let measuring = false;

  let deadline = Infinity;
  const worker = async (total: number): Promise<void> => {
    for (;;) {
      if (issued >= total || performance.now() > deadline) return;
      issued++;
      const r = await once(target, method, hdrs, payload, agent);
      if (measuring) {
        latencies.push(r.ms);
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      }
    }
  };

  // Warmup: JIT, TCP establishment, and the first-call cost of anything lazy. Measured requests
  // would otherwise carry it, and it belongs to the runtime rather than to the target.
  if (warmup > 0) {
    issued = 0;
    // Warmup gets its own, shorter budget. Without one it inherits the slowest cell's arithmetic —
    // 200 warmup requests at 1 worker against a 200 ms upstream is 40 seconds of doing nothing
    // measurable, per cell.
    deadline = performance.now() + Math.min(maxSeconds, 10) * 1000;
    await Promise.all(Array.from({ length: concurrency }, () => worker(warmup)));
  }

  issued = 0;
  measuring = true;
  const t0 = performance.now();
  deadline = maxSeconds === Infinity ? Infinity : t0 + maxSeconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, () => worker(requests)));
  const seconds = (performance.now() - t0) / 1000;
  measuring = false;

  agent.destroy();

  const errors = Object.entries(byStatus)
    .filter(([s]) => Number(s) === 0 || Number(s) >= 500)
    .reduce((a, [, n]) => a + n, 0);

  return { sorted: latencies.sort((a, b) => a - b), count: latencies.length, errors, seconds, rps: latencies.length / seconds, byStatus };
}

/**
 * What this driver can push, on this machine, with nothing in the way.
 *
 * Every throughput figure is reported against this. A gateway result at or near the ceiling is not a
 * measurement of the gateway — it is a measurement of the driver, and saying so is the whole reason
 * this exists.
 */
export async function calibrate(mockUrl: string, concurrency: number, requests: number): Promise<RunResult> {
  return run({
    url: `${mockUrl}/v1/chat/completions`,
    concurrency,
    requests,
    warmup: Math.min(2_000, requests),
    body: { model: 'bench-model-1', messages: [{ role: 'user', content: 'ping' }] },
  });
}

/**
 * Is a throughput figure a measurement of the gateway, or of something else?
 *
 * Two different limits can cap a run, and confusing them is how a benchmark ends up reporting its
 * own harness as a product characteristic:
 *
 *   the DRIVER ceiling      what this script can generate on this machine with nothing in the way.
 *                           Measured once, at zero upstream latency. A result at this ceiling says
 *                           nothing about the target.
 *
 *   the LATENCY ceiling     concurrency ÷ upstream latency. With 8 workers against a 200 ms
 *                           upstream, 40 RPS is arithmetic, not a finding — no gateway of any
 *                           quality could exceed it, and reaching it is the CORRECT outcome.
 *
 * The first version of this function compared the gateway against the direct run and called a high
 * ratio "saturated". That is backwards: a gateway matching the direct run is the result you want.
 * What actually invalidates a number is the gateway sitting on the DRIVER ceiling, because then its
 * real limit is somewhere above what was observed and cannot be seen from here.
 */
export interface Verdict { trustworthy: boolean; note: string }

export function saturationVerdict(
  gatewayRps: number, driverCeiling: number, concurrency: number, upstreamLatencyMs: number,
): Verdict {
  const latencyCeiling = upstreamLatencyMs > 0 ? (concurrency * 1000) / upstreamLatencyMs : Infinity;

  if (gatewayRps >= driverCeiling * 0.9) {
    return {
      trustworthy: false,
      note: `SATURATED BY DRIVER — at ${gatewayRps.toFixed(0)} RPS against a ${driverCeiling.toFixed(0)} RPS harness ceiling, ` +
            'the gateway\'s real limit is above what this run can see',
    };
  }
  if (upstreamLatencyMs > 0 && gatewayRps >= latencyCeiling * 0.9) {
    return {
      trustworthy: true,
      note: `LATENCY-BOUND, as intended — ${concurrency} workers against a ${upstreamLatencyMs} ms upstream cannot exceed ` +
            `${latencyCeiling.toFixed(0)} RPS. Reaching it means the gateway added almost nothing.`,
    };
  }
  return { trustworthy: true, note: 'gateway-bound — this is a measurement of Nexus' };
}

/** A markdown row, so results paste straight into docs/BENCHMARKS.md without hand-formatting. */
export const ms = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(1));

export function tableRow(label: string, r: RunResult): string {
  return `| ${label} | ${ms(p50(r.sorted))} | ${ms(p95(r.sorted))} | ${ms(p99(r.sorted))} | ${r.rps.toFixed(0)} | ${r.errors} |`;
}

export const TABLE_HEAD =
  '| scenario | p50 ms | p95 ms | p99 ms | RPS | errors |\n|---|---|---|---|---|---|';
