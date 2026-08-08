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

// Open-loop load against the gateway, for the numbers we intend to publish.
//
// ── Why not the driver we already have ────────────────────────────────────────────────────────
//
// scripts/bench/driver.ts is closed-loop: each worker sends a request, waits for the response, and
// only then sends the next. That is fine for comparing two builds of our own code, and it is
// unusable as a published tail latency, because of coordinated omission.
//
// The failure is easy to state. When the server stalls, a closed-loop generator politely stops
// sending — so the requests that would have arrived DURING the stall are never made, and the stall
// never appears in the percentiles. The worse the server behaves, the fewer slow samples the
// measurement takes. A p99 gathered that way is not conservative; it is systematically optimistic,
// and it is the first thing a performance engineer will attack.
//
// `constant-arrival-rate` is the fix. k6 starts an iteration on a schedule regardless of whether
// earlier ones have finished, which is how real traffic arrives: users do not wait for each other.
//
// ── Reading `dropped_iterations` ──────────────────────────────────────────────────────────────
//
// If k6 cannot start an iteration on time because every VU is still busy, it drops it and counts
// it. That counter is not noise to be tuned away — it is the measurement telling you the arrival
// rate exceeded what the system could absorb. `maxVUs` is set generously by the runner so that a
// drop means the GATEWAY could not keep up rather than that the generator ran out of workers.

import http from 'k6/http';
import { check } from 'k6';

const RATE = parseInt(__ENV.RATE, 10);
const DURATION = __ENV.DURATION || '20s';
const TARGET = __ENV.TARGET_URL;
const API_KEY = __ENV.API_KEY;

export const options = {
  // The response body is identical every time and nothing here asserts on it, so discarding it
  // keeps the generator's own allocation out of the numbers.
  discardResponseBodies: true,
  // p(99.9) is not in k6's default summary and is the figure that actually distinguishes gateways
  // under load — a p99 hides one request in a hundred, which at 1,000 rps is ten a second.
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
  scenarios: {
    // Setting VUS switches this to a CLOSED loop, which exists purely so the two can be compared
    // on the same tool, the same network and the same gateway — changing one variable. That
    // comparison is the evidence for why the open-loop numbers are the ones published: run both and
    // the closed loop reports a far kinder tail for the same system, because it stops sending while
    // the server is stalled and never samples the stall.
    load: __ENV.VUS
      ? {
        executor: 'constant-vus',
        vus: parseInt(__ENV.VUS, 10),
        duration: DURATION,
        gracefulStop: '10s',
      }
      : {
        executor: 'constant-arrival-rate',
        rate: RATE,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: parseInt(__ENV.PRE_VUS || '100', 10),
        maxVUs: parseInt(__ENV.MAX_VUS || '2000', 10),
        // A short warmup would still be measured, so the runner discards the first run at each rate
        // instead of trying to exclude time from within one.
        gracefulStop: '10s',
      },
  },
};

const BODY = JSON.stringify({
  model: 'alayra-nexus-1',
  messages: [{ role: 'user', content: 'Benchmark request.' }],
});

const PARAMS = {
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
};

export default function () {
  const res = http.post(TARGET, BODY, PARAMS);
  check(res, { 'status is 200': (r) => r.status === 200 });
}

/**
 * Emit one machine-readable line the runner can find.
 *
 * k6's human summary goes to stderr in the container and is noisy to parse; a single tagged JSON
 * line on stdout is unambiguous, and keeps the raw numbers available for the artifacts a published
 * benchmark has to ship alongside its prose.
 */
export function handleSummary(data) {
  const d = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : {};
  const reqs = data.metrics.http_reqs ? data.metrics.http_reqs.values : {};
  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values : {};
  const dropped = data.metrics.dropped_iterations ? data.metrics.dropped_iterations.values : {};

  const summary = {
    requestedRate: __ENV.VUS ? 0 : RATE,
    closedLoopVus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 0,
    achievedRps: reqs.rate || 0,
    requests: reqs.count || 0,
    failedRate: failed.rate || 0,
    droppedIterations: dropped.count || 0,
    med: d.med || 0,
    p90: d['p(90)'] || 0,
    p95: d['p(95)'] || 0,
    p99: d['p(99)'] || 0,
    p999: d['p(99.9)'] || 0,
    max: d.max || 0,
  };

  return { stdout: `NEXUS_K6_JSON:${JSON.stringify(summary)}\n` };
}
