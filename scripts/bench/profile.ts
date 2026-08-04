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

// Where does the ~3ms go?
//
// Scenario 1 established that the gateway costs about 3ms of CPU per request and that throughput
// barely moves between 1 and 32 workers — the signature of one saturated thread. That says the cost
// is ours and it is CPU. It does not say WHICH code, and every optimisation proposed on the
// strength of reading the source is a guess until this script disagrees with it.
//
//   npm run build && npm run bench:profile
//
// ── Two runs, on purpose ──────────────────────────────────────────────────────────────────────
//
// c=1  — one request at a time. Nothing can queue, so the profile is the composition of a single
//        request's latency. Mostly idle, waiting on the socket; the analyzer excludes idle.
// c=8  — the thread is saturated. This is the profile that explains the THROUGHPUT ceiling, and it
//        is the one to optimise against.
//
// Reading them together is what makes them worth doing separately: a frame that is large at c=8 and
// absent at c=1 is queueing or backpressure, not per-request cost. A frame that is large in both is
// real work on every request, and that is what we are hunting.
//
// Each run gets its own gateway, so no state from the first leaks into the second.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, report } from './analyzeProfile';
import { run } from './driver';
import { COMPLETION_BODY, setUpstream, startHarness } from './gateway';

const MOCK_PORT = 3210;
const GATEWAY_PORT = 3401;
const CONTROL_PORT = 3402;

/** Long enough that a hotspot cannot hide in the noise; short enough to iterate on. */
const SECONDS = parseInt(process.env.PROFILE_SECONDS ?? '20', 10);
const OUT_DIR = process.env.PROFILE_DIR ?? join(process.cwd(), '.bench');

const post = (url: string): Promise<Response> => fetch(url, { method: 'POST' });

interface Phase { label: string; concurrency: number }

const PHASES: Phase[] = [
  { label: 'c1', concurrency: 1 },
  { label: 'c8', concurrency: 8 },
];

async function profileOne(phase: Phase): Promise<string> {
  const out = join(OUT_DIR, `nexus-${phase.label}.cpuprofile`);
  const h = await startHarness(MOCK_PORT, GATEWAY_PORT, {
    profile: { controlPort: CONTROL_PORT, out },
  });

  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    const load = {
      url: `${h.gatewayUrl}/v1/chat/completions`,
      method: 'POST' as const,
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: COMPLETION_BODY,
      concurrency: phase.concurrency,
    };

    // Warm up OUTSIDE the profiled window. The first few hundred requests run in the interpreter
    // before V8 has tiered anything up, and profiling them would rank the optimiser's own work
    // above the code it was optimising — a real hotspot would be buried under Ignition frames that
    // do not exist in steady state.
    await run({ ...load, requests: 2_000, warmup: 0, maxSeconds: 10 });

    await post(`${h.profileControlUrl}/start`);
    const result = await run({
      ...load,
      requests: Number.MAX_SAFE_INTEGER,   // bounded by maxSeconds, not by a count
      warmup: 0,
      maxSeconds: SECONDS,
    });
    const stopped = await post(`${h.profileControlUrl}/stop`);
    const meta = await stopped.json() as { samples: number; durationMs: number };

    console.log(
      `${phase.label}: ${result.count} requests, ${result.rps.toFixed(0)} rps, ` +
      `${result.errors} errors — ${meta.samples} samples over ${(meta.durationMs / 1000).toFixed(1)}s`,
    );
    if (result.errors > 0) {
      console.log('  NOTE: errors in a profiled run mean some samples are the error path, not the happy path.');
    }
    return out;
  } finally {
    h.dispose();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const reports: string[] = [];

  for (const phase of PHASES) {
    console.log(`\n── profiling ${phase.label} (concurrency ${phase.concurrency}, ${SECONDS}s) ──`);
    const file = await profileOne(phase);
    const summary = analyze(JSON.parse(readFileSync(file, 'utf8')));
    const text = `\n════ ${phase.label} (concurrency ${phase.concurrency}) ════\n${report(summary, 30)}`;
    console.log(text);
    reports.push(text);
  }

  const combined = join(OUT_DIR, 'profile-report.txt');
  writeFileSync(combined, reports.join('\n'));
  console.log(`\nprofiles and report written to ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
