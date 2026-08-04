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
import { assertClusterSafe, ClusterUnsafeError, desiredWorkers, ownsBackgroundJobs } from './cluster';

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
