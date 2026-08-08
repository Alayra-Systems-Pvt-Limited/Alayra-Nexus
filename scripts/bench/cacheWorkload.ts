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

// The traffic shape the cache benchmark sends.
//
// Its own module so it can be tested, for the same reason monitor.ts is: scripts/bench/cache.ts
// calls main() at import, so a test importing it would start Docker and a gateway.
//
// This is small and it is the piece most worth testing, because the way it fails is silent and
// flattering. If a prompt meant to be new has been sent before, the gateway serves it from cache,
// the benchmark counts it as a miss, and every headline figure — hit rate, calls avoided, dollars
// saved — moves in our favour. Nothing crashes and no number looks obviously wrong.

import { completionBody } from './gateway';

/** Where unique prompts start, far above any hot-set index so the two can never collide. */
const UNIQUE_BASE = 1_000_000;

/**
 * A request-body generator for a given repeat rate.
 *
 * `repeatRate` is the fraction of requests drawn from a small hot set; the rest are globally unique
 * and therefore guaranteed misses. With the hot set primed beforehand, the repeat fraction IS the
 * hit rate — which is what makes the sweep a controlled experiment rather than an observation.
 *
 * Deterministic rather than random: `i % 100 < rate*100` lands on the requested ratio exactly, where
 * sampling would land near it and leave every difference between two cells arguable.
 *
 * ONE generator must be shared by every phase of a cell. Its unique counter is closure state, so a
 * fresh generator restarts it and re-sends prompts an earlier phase already cached. The test for
 * that is the reason this file exists.
 */
export function workloadBody(
  repeatRate: number, hotSet: number,
): (index: number) => Record<string, unknown> {
  let unique = 0;
  const threshold = Math.round(repeatRate * 100);
  return (index: number) => (index % 100) < threshold
    ? completionBody(index % hotSet)          // primed, so a hit
    : completionBody(UNIQUE_BASE + unique++); // never sent before, so a miss
}

/** The prompt text of a generated body, for tests and for debugging a surprising result. */
export function promptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { content: string }[];
  return messages[0]!.content;
}
