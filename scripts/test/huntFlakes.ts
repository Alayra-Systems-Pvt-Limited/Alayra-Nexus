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

// Make a flaky test fail on purpose (Phase S2.5).
//
//   npm run test:hunt                    -- 25 runs, file order shuffled
//   npm run test:hunt -- 100             -- longer hunt
//   npm run test:hunt -- 25 --shuffle-tests   -- also reorder tests WITHIN each file
//   npm run test:hunt -- 25 --same-order      -- no reordering at all
//
// A test that fails once in fifty is not a mystery to be waited out, it is a bug that has not been
// reproduced yet. Waiting is how it becomes permanent: it fires during a release, somebody hits
// rerun, it goes green, and from then on a red build means "try again" instead of "stop". The way
// out is to reproduce it deliberately, and the cheapest lever is ORDER.
//
// Vitest runs test files in parallel workers, in a stable order, so a suite with hidden coupling —
// one file leaving a mutated module, an env var, a shared row, a fake timer, a listening port —
// passes every time until something unrelated perturbs the schedule. Shuffling files and tests on a
// fresh seed each run perturbs it on purpose, and each run is a distinct experiment rather than the
// same one repeated.
//
// WHAT THIS DOES NOT DO: it never retries, and it never reports a run as anything but what happened.
// A hunt that "passes on the second attempt" has found the bug, not cleared it.
//
// Every failing run is written out whole — seed, order, full output — under .flake-hunt/, because
// the entire difficulty with a rare failure is that nobody was watching when it happened.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const OUT = join(ROOT, '.flake-hunt');

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 25);
/** Escape hatch: hunt WITHOUT reordering, to tell a genuinely time/state-dependent flake from an order-dependent one. */
const sameOrder = args.includes('--same-order');

/**
 * Also shuffle the tests WITHIN each file. Off by default, and the distinction is not fussiness.
 *
 * FILE order genuinely varies run to run — Vitest schedules files across workers as they free up, so
 * a failure that depends on file order is a failure that can happen in CI. Shuffling files is
 * therefore a faithful experiment.
 *
 * TEST order within a file does not vary: Vitest runs them in declaration order, and a suite is
 * entitled to rely on that. src/lib/parity/reset.parity.test.ts does — it seeds, asserts the seed is
 * there, wipes, then asserts the wipe — and reordering those makes it fail in a way that proves
 * nothing, because it cannot happen. Left on by default, that noise would be the loudest thing in
 * every hunt and the real findings would be read as more of it.
 *
 * It stays available because it is genuinely useful for a different question: not "will this fail in
 * CI" but "which tests are silently coupled". It is what caught proxyDispatch.service.test.ts
 * inheriting a previous test's fetch stub — a latent bug that passed in the committed order and
 * would have detonated the first time somebody inserted a case in the middle.
 */
const shuffleTests = args.includes('--shuffle-tests');

interface Failure { run: number; seed: number; code: number | null; ms: number; log: string }

function runOnce(run: number, seed: number): { ok: boolean; ms: number; code: number | null; log: string } {
  const vitest = [
    'vitest', 'run',
    // Vitest reports its seed on every run, but only a seed we CHOSE can be replayed — so the seed
    // is an input here, printed with each result and recorded with each failure.
    ...(sameOrder ? [] : [
      '--sequence.shuffle.files=true',
      `--sequence.shuffle.tests=${shuffleTests}`,
      `--sequence.seed=${seed}`,
    ]),
  ];

  const started = Date.now();
  const r = spawnSync('npx', vitest, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    // Inherit the environment exactly, PARITY_* included: a hunt against a suite whose parity files
    // silently skipped would prove nothing about the half most likely to be order-dependent.
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    ok: r.status === 0,
    ms: Date.now() - started,
    code: r.status,
    log: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
  };
}

function main(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const how = sameOrder
    ? 'in the usual order'
    : `shuffling files${shuffleTests ? ' AND tests within each file' : ''}, a new seed each run`;
  console.log(`\nHunting for flaky tests: ${runs} full runs, ${how}.\n`);

  const failures: Failure[] = [];
  const durations: number[] = [];

  for (let i = 1; i <= runs; i++) {
    // Derived from the run index, not from a clock: a hunt has to be repeatable, and "it failed on
    // seed 7" is only useful if seed 7 can be run again.
    const seed = 1000 + i;
    const { ok, ms, code, log } = runOnce(i, seed);
    durations.push(ms);

    if (ok) {
      console.log(`  ${String(i).padStart(3)}/${runs}  pass   seed ${seed}   ${(ms / 1000).toFixed(1)}s`);
      continue;
    }

    const file = join(OUT, `run-${String(i).padStart(3, '0')}-seed-${seed}.log`);
    writeFileSync(file, log);
    failures.push({ run: i, seed, code, ms, log });
    console.log(`  ${String(i).padStart(3)}/${runs}  FAIL   seed ${seed}   ${(ms / 1000).toFixed(1)}s   → ${file}`);

    // The failing test names, inline, so a long hunt does not have to be babysat.
    for (const line of log.split('\n').filter((l) => /^\s*(×|FAIL)\s/.test(l)).slice(0, 12)) {
      console.log(`         ${line.trim()}`);
    }
  }

  const total = durations.reduce((a, b) => a + b, 0);
  console.log(
    `\n  ${runs} runs in ${(total / 1000 / 60).toFixed(1)} min ` +
    `(median ${(durations.slice().sort((a, b) => a - b)[Math.floor(runs / 2)] / 1000).toFixed(1)}s each)`);

  if (failures.length === 0) {
    console.log(
      `\n  No failures in ${runs} runs.\n\n` +
      `  This is EVIDENCE, NOT A VERDICT. It bounds the failure rate at roughly 1 in ${runs} and\n` +
      `  rules out the order-dependent causes this hunt perturbs — it does not prove the suite is\n` +
      `  sound. A flake that needs a slow CI runner, a cold cache or a particular clock will not\n` +
      `  appear on a fast local machine no matter how many times it is run.\n`);
    process.exit(0);
  }

  console.log(`\n  ${failures.length} of ${runs} runs FAILED. Seeds: ${failures.map((f) => f.seed).join(', ')}`);
  console.log(
    `  Replay one with:  npx vitest run --sequence.shuffle.files=true ` +
    `--sequence.shuffle.tests=${shuffleTests} --sequence.seed=${failures[0].seed}\n`);
  process.exit(1);
}

main();
