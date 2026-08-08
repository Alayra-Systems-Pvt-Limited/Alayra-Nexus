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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const prismaMock = { nexusProvider: { findMany: vi.fn(async () => []) } };
  return { prismaMock, store };
});

// A stand-in for the KV that behaves like the real one for the three calls used here. TTL is
// accepted and ignored: expiry is Redis's job, and a test that waited for it would be a slow test
// of somebody else's code.
vi.mock('../lib/redis', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  },
}));
vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { getActiveProviders, invalidateProviderCache } from './providerCache.service';
import { PROVIDER_CACHE_KEY } from '../lib/registryCacheKey';

const row = (id: string, provider: string, tier = 'standard') => ({
  id, baseUrl: `https://${provider}.test/v1`, provider,
  authHeader: 'Authorization', authPrefix: 'Bearer ', tier,
  preferredModel: null, extraHeaders: null,
});

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  // There are two tiers now — the shared copy in the KV, and an in-process memo in front of it.
  // Emptying only the first leaves the second serving the previous test's pools, which is exactly
  // the staleness this cache is designed to bound and exactly what a unit test must not inherit.
  await invalidateProviderCache();
  prismaMock.nexusProvider.findMany.mockResolvedValue([]);
});

describe('getActiveProviders', () => {
  it('queries once and serves every later call from the cache', async () => {
    prismaMock.nexusProvider.findMany.mockResolvedValue([row('p1', 'openai')]);

    const first = await getActiveProviders();
    const second = await getActiveProviders();
    const third = await getActiveProviders();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    // The whole point of the change: three routed requests, one query.
    expect(prismaMock.nexusProvider.findMany).toHaveBeenCalledTimes(1);
  });

  it('asks only for active pools, oldest first', async () => {
    await getActiveProviders();
    const arg = prismaMock.nexusProvider.findMany.mock.calls[0]?.[0] as unknown as {
      where: { isActive: boolean }; orderBy: { createdAt: string };
    };
    // Ordering is applied once here because every caller now filters in memory, and a filter
    // cannot reorder. If this stopped being ordered, routing would silently stop being LRU-stable.
    expect(arg.where).toEqual({ isActive: true });
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('selects only scalar columns, so nothing survives JSON as the wrong type', async () => {
    await getActiveProviders();
    const arg = prismaMock.nexusProvider.findMany.mock.calls[0]?.[0] as unknown as {
      select: Record<string, boolean>;
    };
    // A DateTime column here would come back from JSON.parse as a string while TypeScript still
    // called it a Date — compiles, throws at runtime. The guard is that createdAt is NOT selected,
    // despite being the column we order by.
    expect(arg.select).toBeDefined();
    expect(arg.select.createdAt).toBeUndefined();
    expect(Object.keys(arg.select).sort()).toEqual([
      'authHeader', 'authPrefix', 'baseUrl', 'extraHeaders', 'id', 'preferredModel', 'provider', 'tier',
    ]);
  });

  it('re-reads after invalidation, and sees the new pools', async () => {
    prismaMock.nexusProvider.findMany.mockResolvedValue([row('p1', 'openai')]);
    expect(await getActiveProviders()).toHaveLength(1);

    // An operator adds a pool. Without the invalidate this returns the stale single-pool list, which
    // is the whole failure mode this cache introduces and the reason every write path calls it.
    prismaMock.nexusProvider.findMany.mockResolvedValue([row('p1', 'openai'), row('p2', 'groq')]);
    expect(await getActiveProviders()).toHaveLength(1);

    await invalidateProviderCache();
    expect(await getActiveProviders()).toHaveLength(2);
    expect(prismaMock.nexusProvider.findMany).toHaveBeenCalledTimes(2);
  });

  it('survives a corrupt cache entry by re-reading rather than throwing', async () => {
    store.set(PROVIDER_CACHE_KEY, '{not json');
    prismaMock.nexusProvider.findMany.mockResolvedValue([row('p1', 'openai')]);

    // A half-written or version-skewed entry must not take routing down with it.
    expect(await getActiveProviders()).toEqual([row('p1', 'openai')]);
  });

  it('caches an empty result too, so a gateway with no pools does not query per request', async () => {
    await getActiveProviders();
    await getActiveProviders();
    expect(prismaMock.nexusProvider.findMany).toHaveBeenCalledTimes(1);
  });
});
