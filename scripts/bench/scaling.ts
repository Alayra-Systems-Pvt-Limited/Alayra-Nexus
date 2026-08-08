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

// Does the gateway scale across cores?
//
// One process tops out near 670 requests a second because that is one core's worth of CPU divided
// by the CPU a request costs, and no amount of concurrency adds a second core. Node's answer is
// more processes sharing a listening socket. This measures whether that actually works, one worker
// at a time, so a scaling curve that bends can be seen bending rather than inferred from endpoints.
//
//   npm run bench:scaling
//
// ── Postgres and Redis, not the standalone file ───────────────────────────────────────────────
//
// Not a preference: the gateway REFUSES to fork without a shared Redis, because four workers on an
// in-process map would each enforce the full per-key RPM limit. So this brings up both in Docker.
// It is also the honest topology — nobody runs four workers against a SQLite file.
//
// A fresh database per worker count, because the harness claims the gateway and creates a pool on
// first boot, and that only works once. A separate Redis DB index per run for the same reason.
//
// ── The measurement's own limit, which is reported rather than hidden ─────────────────────────
//
// The load driver runs on the same machine as the gateway. At one worker that barely matters; at
// four it very much does, because the driver needs a core of its own and Docker is holding two
// containers. So every run also measures the driver against the mock DIRECTLY, at the same moment.
// If that direct ceiling falls as workers are added, the machine ran out of cores and the scaling
// figure is a floor, not a finding. Distinguishing those two is the entire point of measuring it.

import {
  containersDown, containersUp, createDatabase, migrate, redisUrlFor, waitForPostgres, waitForRedis,
} from './containers';
import { p50, p95, p99, run, calibrate, ms, type RunResult } from './driver';
import { COMPLETION_BODY, setUpstream, startHarness } from './gateway';

const MOCK_PORT = 3210;
const GATEWAY_PORT = 3401;

/** Worker counts to walk, one at a time so a bend in the curve is visible. */
const WORKER_COUNTS = (process.env.BENCH_WORKERS ?? '1,2,3,4').split(',').map((n) => parseInt(n, 10));

/**
 * Two concurrencies, because they answer different questions.
 *
 * 8 is light enough that a request is rarely queued, so the percentiles are latency. 64 is heavy
 * enough to saturate four workers, so the RPS is capacity — and its percentiles are queueing, which
 * is why both are reported rather than one.
 */
const CONCURRENCIES = [8, 64];

const SECONDS = parseInt(process.env.BENCH_MAX_SECONDS ?? '12', 10);

const sleep = (msec: number): Promise<void> => new Promise((r) => setTimeout(r, msec));

interface Cell {
  workers: number;
  concurrency: number;
  gateway: RunResult;
  driverCeiling: number;
}

async function measure(workers: number, index: number): Promise<Cell[]> {
  const databaseUrl = createDatabase(`nexus_bench_${workers}`);
  migrate(databaseUrl);

  // A Redis database per run, so one run's rate-limit counters and sticky pins cannot be read by
  // the next. See containers.ts.
  const redisUrl = redisUrlFor(index);

  const h = await startHarness(MOCK_PORT, GATEWAY_PORT, { workers, databaseUrl, redisUrl });
  const cells: Cell[] = [];

  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    const load = {
      url: `${h.gatewayUrl}/v1/chat/completions`,
      method: 'POST' as const,
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: COMPLETION_BODY,
    };

    for (const concurrency of CONCURRENCIES) {
      // The driver's own ceiling, measured NOW rather than once at the start: the machine is busier
      // with four workers on it than with one, and a ceiling from a quieter moment would flatter
      // the result exactly where it matters most.
      const direct = await calibrate(h.mockUrl, concurrency, 20_000);

      const gateway = await run({
        ...load,
        concurrency,
        requests: Number.MAX_SAFE_INTEGER,
        warmup: 2_000,
        maxSeconds: SECONDS,
      });

      cells.push({ workers, concurrency, gateway, driverCeiling: direct.rps });
      console.log(
        `  workers=${workers} c=${concurrency}: ${gateway.rps.toFixed(0)} rps ` +
        `(p50 ${ms(p50(gateway.sorted))} p95 ${ms(p95(gateway.sorted))} p99 ${ms(p99(gateway.sorted))}) ` +
        `— driver ceiling ${direct.rps.toFixed(0)} rps, ${gateway.errors} errors`,
      );
    }
    return cells;
  } finally {
    h.dispose();
    // Workers take a moment to release the port; starting the next run into a half-closed socket
    // produces a confusing "gateway never answered".
    await sleep(1_500);
  }
}

function report(cells: Cell[]): void {
  for (const concurrency of CONCURRENCIES) {
    const rows = cells.filter((c) => c.concurrency === concurrency);
    const base = rows.find((r) => r.workers === 1)?.gateway.rps ?? 0;

    console.log(`\n── concurrency ${concurrency} ──\n`);
    console.log('| workers | RPS | vs 1 worker | efficiency | p50 ms | p95 ms | p99 ms | driver ceiling | errors |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const speedup = base > 0 ? r.gateway.rps / base : 0;
      // Efficiency is speedup per worker. 100% is perfect scaling; the interesting number is where
      // it starts falling and whether the driver ceiling fell with it.
      const efficiency = r.workers > 0 ? (speedup / r.workers) * 100 : 0;
      console.log(
        `| ${r.workers} | ${r.gateway.rps.toFixed(0)} | ${speedup.toFixed(2)}× | ${efficiency.toFixed(0)}% | ` +
        `${ms(p50(r.gateway.sorted))} | ${ms(p95(r.gateway.sorted))} | ${ms(p99(r.gateway.sorted))} | ` +
        `${r.driverCeiling.toFixed(0)} | ${r.gateway.errors} |`,
      );
    }

    // Say plainly when a row cannot be trusted, rather than leaving it to be noticed.
    const first = rows[0];
    for (const r of rows) {
      if (first && r.driverCeiling < first.driverCeiling * 0.75) {
        console.log(
          `\n  NOTE: at ${r.workers} workers the driver itself only reached ${r.driverCeiling.toFixed(0)} rps, ` +
          `against ${first.driverCeiling.toFixed(0)} at 1 worker. The machine is out of cores, so this row is a ` +
          'FLOOR on what the gateway can do, not a measurement of it.',
        );
      }
    }
  }
}

async function main(): Promise<void> {
  containersUp();
  await waitForPostgres();
  await waitForRedis();

  const cells: Cell[] = [];
  try {
    for (let i = 0; i < WORKER_COUNTS.length; i++) {
      const workers = WORKER_COUNTS[i]!;
      console.log(`\n── ${workers} worker${workers === 1 ? '' : 's'} ──`);
      cells.push(...await measure(workers, i));
    }
    report(cells);
  } finally {
    containersDown();
  }
}

main().catch((e) => { console.error(e); containersDown(); process.exit(1); });
