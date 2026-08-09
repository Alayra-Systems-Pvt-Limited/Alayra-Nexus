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

import { cpus } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertClusterSafe, ClusterUnsafeError, desiredWorkers, ownsBackgroundJobs,
  forkDelayMs, createCrashWindow, FORK_BACKOFF_MAX_MS, CRASH_WINDOW_MS,
} from './cluster';

const CORES = cpus().length;
const REDIS = { usingMemoryKv: false, dbEngine: 'postgres' };
const MEMORY = { usingMemoryKv: true, dbEngine: 'sqlite' };

describe('desiredWorkers', () => {
  it('is one when unset — the gateway does not cluster by accident', () => {
    expect(desiredWorkers({})).toBe(1);
    expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: '' })).toBe(1);
  });

  it('reads an explicit count', () => {
    expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: '4' })).toBe(4);
  });

  it('maps auto to one worker per core', () => {
    expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: 'auto' })).toBe(CORES);
    expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: 'AUTO' })).toBe(CORES);
  });

  it('falls back to one for anything unparseable', () => {
    // A typo must not silently start a cluster — the failure mode of that is multiplied rate
    // limits, which is far worse than not scaling.
    for (const raw of ['many', '2.5', '0', '-3', 'true']) {
      expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: raw })).toBe(1);
    }
  });

  it('caps far above the core count rather than refusing to boot', () => {
    // Workers past this only take turns on the same cores while each holds its own connection
    // pool. Degrading is friendlier than failing for what is usually a copied config.
    expect(desiredWorkers({ NEXUS_CLUSTER_WORKERS: '9999' })).toBe(CORES * 2);
  });
});

describe('assertClusterSafe', () => {
  it('allows a single worker on the in-memory store — that is standalone mode', () => {
    expect(() => assertClusterSafe(1, MEMORY)).not.toThrow();
  });

  it('refuses to fork without a shared Redis', () => {
    // The whole reason this module exists. Each worker would keep its own RPM/TPM counters, so the
    // operator's per-key limits would be enforced once per worker.
    expect(() => assertClusterSafe(4, MEMORY)).toThrow(ClusterUnsafeError);
  });

  it('says what would break, and by how much', () => {
    // The message is the feature: an operator reading it should understand the consequence without
    // having to find this file.
    try {
      assertClusterSafe(4, MEMORY);
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('REDIS_URL');
      expect(msg).toContain('240');        // 60 rpm x 4 workers, spelled out
      expect(msg).toContain('NEXUS_CLUSTER_WORKERS');
    }
  });

  it('allows a cluster once there is a real Redis', () => {
    expect(() => assertClusterSafe(4, REDIS)).not.toThrow();
  });
});

describe('ownsBackgroundJobs', () => {
  it('is true for a single process, which has no worker id', () => {
    expect(ownsBackgroundJobs(undefined)).toBe(true);
  });

  it('gives the jobs to the first worker only', () => {
    // Retention, the health sampler and the backup scheduler are per-deployment, not per-process.
    expect(ownsBackgroundJobs(1)).toBe(true);
    expect(ownsBackgroundJobs(2)).toBe(false);
    expect(ownsBackgroundJobs(4)).toBe(false);
  });
});

describe('forkDelayMs (the fork loop this exists to stop)', () => {
  it('replaces the first casualty immediately', () => {
    // One worker hitting a bug on one request is what supervision is FOR. It must not be slowed
    // down by protection aimed at a different failure.
    expect(forkDelayMs(1)).toBe(0);
  });

  it('backs off once deaths start repeating', () => {
    expect(forkDelayMs(2)).toBe(200);
    expect(forkDelayMs(3)).toBe(400);
    expect(forkDelayMs(4)).toBe(800);
    expect(forkDelayMs(5)).toBe(1600);
  });

  it('stops climbing at the cap, and never gives up', () => {
    // Never returning "don't fork" is deliberate: a cap that stopped replacing workers would turn
    // a recoverable dependency outage into one that needs a human.
    expect(forkDelayMs(20)).toBe(FORK_BACKOFF_MAX_MS);
    expect(forkDelayMs(200)).toBe(FORK_BACKOFF_MAX_MS);
    expect(Number.isFinite(forkDelayMs(2000))).toBe(true);
  });

  it('reaches a sane ceiling fast enough to matter', () => {
    // The scenario is every worker dying at boot because Redis is unreachable. Left at zero delay
    // that is a spin; the curve has to be steep enough to stop it within a second or so.
    let elapsed = 0;
    for (let crash = 1; crash <= 10; crash++) elapsed += forkDelayMs(crash);
    expect(elapsed).toBeGreaterThan(1_000);
    expect(forkDelayMs(10)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('createCrashWindow', () => {
  it('counts the crash it is given', () => {
    const w = createCrashWindow();
    expect(w.record(1_000)).toBe(1);
    expect(w.record(1_100)).toBe(2);
    expect(w.record(1_200)).toBe(3);
  });

  it('forgets crashes older than the window', () => {
    const w = createCrashWindow(60_000);
    w.record(0);
    w.record(1_000);
    // An hour later, the earlier pair must not still be counting against this one.
    expect(w.record(3_600_000)).toBe(1);
  });

  it('never penalises a gateway that loses one worker occasionally', () => {
    const w = createCrashWindow(CRASH_WINDOW_MS);
    let at = 0;
    for (let i = 0; i < 20; i++) {
      at += CRASH_WINDOW_MS * 2;              // one death every two windows
      expect(forkDelayMs(w.record(at))).toBe(0);
    }
  });

  it('does penalise a gateway whose workers are dying continuously', () => {
    const w = createCrashWindow(CRASH_WINDOW_MS);
    let at = 0;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      at += 50;                               // as fast as a failing boot loops
      last = forkDelayMs(w.record(at));
    }
    expect(last).toBe(FORK_BACKOFF_MAX_MS);
  });
});
