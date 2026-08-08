/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The cache benchmark's traffic shape.
//
// Every headline figure that benchmark prints — hit rate, calls avoided, dollars saved — rests on
// one claim: a request meant to MISS has never been sent before. If that is ever false the gateway
// serves it from cache, the benchmark counts it as a miss, and every number moves in our own favour
// while nothing crashes and no result looks obviously wrong.
//
// That is the failure worth a test, and it is not hypothetical: the first version built a fresh
// generator for the warm phase and another for the measured phase, which silently re-sent the warm
// phase's "unique" prompts into a cache that already held them.

import { describe, it, expect } from 'vitest';
import { workloadBody, promptOf } from './cacheWorkload';

const HOT = 20;

/** The prompts a generator produces for `n` requests, in order. */
function prompts(gen: (i: number) => Record<string, unknown>, n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) => promptOf(gen(from + i)));
}

describe('workloadBody', () => {
  it('sends nothing but unique prompts at a 0% repeat rate', () => {
    const seen = prompts(workloadBody(0, HOT), 500);
    expect(new Set(seen).size).toBe(500);
  });

  it('sends nothing but hot-set prompts at a 100% repeat rate', () => {
    const seen = prompts(workloadBody(1, HOT), 500);
    // Every request is one of the primed prompts, so every one of them can hit.
    expect(new Set(seen).size).toBe(HOT);
  });

  it.each([0.25, 0.5, 0.75])('hits exactly %s of a 100-request window', (rate) => {
    const gen = workloadBody(rate, HOT);
    const hot = new Set(prompts(workloadBody(1, HOT), HOT));
    const window = prompts(gen, 100);

    // Exact, not approximate. A sampled generator would land near the rate and leave every
    // difference between two sweep cells arguable.
    expect(window.filter((p) => hot.has(p)).length).toBe(rate * 100);
  });

  it('never repeats a unique prompt across separate phases of ONE generator', () => {
    // The real usage: a warm run, then a measured run, both driven by the same generator. The
    // driver's index restarts at zero when measurement begins, which is exactly the trap — the
    // generator must not restart with it.
    const gen = workloadBody(0, HOT);
    const warm = prompts(gen, 40);        // indices 0..39
    const measured = prompts(gen, 200);   // indices 0..199 again

    expect(new Set([...warm, ...measured]).size).toBe(240);
  });

  it('DOES repeat when a second generator is built — the mistake this guards', () => {
    // Documented as a test rather than a comment so that anyone tempted to construct the generator
    // inside the run helper sees precisely what it would cost: 40 requests that look like misses
    // and are served from cache.
    const warm = prompts(workloadBody(0, HOT), 40);
    const measured = prompts(workloadBody(0, HOT), 200);

    const overlap = measured.filter((p) => warm.includes(p));
    expect(overlap).toHaveLength(40);
  });

  it('keeps unique prompts clear of the hot set at every rate', () => {
    // A collision would turn an intended miss into a hit even with the generator shared correctly.
    const hot = new Set(prompts(workloadBody(1, HOT), HOT));
    for (const rate of [0, 0.25, 0.5, 0.75]) {
      const gen = workloadBody(rate, HOT);
      const window = prompts(gen, 300);
      const unique = window.filter((_, i) => (i % 100) >= Math.round(rate * 100));
      expect(unique.some((p) => hot.has(p))).toBe(false);
    }
  });
});
