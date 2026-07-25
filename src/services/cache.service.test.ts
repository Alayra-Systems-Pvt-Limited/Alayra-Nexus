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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryRaw, countKeys, deleteKeys, getSetting, setSetting } = vi.hoisted(() => ({
  queryRaw:   vi.fn(),
  countKeys:  vi.fn(),
  deleteKeys: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { $queryRaw: queryRaw } }));
vi.mock('../lib/redisScan', () => ({ countKeys, deleteKeys }));
// cache.service transitively imports lib/responseCache, which imports the real ioredis client.
// It is never called here, so an empty stub keeps module load from opening a connection.
vi.mock('../lib/redis', () => ({ redis: {} }));
vi.mock('./settings.service', () => ({ getSetting, setSetting }));

import { getCacheStats, purgeResponseCache } from './cache.service';

beforeEach(() => {
  queryRaw.mockReset(); countKeys.mockReset(); deleteKeys.mockReset();
  getSetting.mockReset(); setSetting.mockReset();
  // No stored settings → config falls back to its off-by-default seed.
  getSetting.mockResolvedValue(null);
});

describe('getCacheStats', () => {
  it('composes config, live entry count, and the recent window', async () => {
    countKeys.mockResolvedValue(42);
    queryRaw.mockResolvedValue([{ hits: 30, successes: 120, saved: 1.5 }]);

    const stats = await getCacheStats();

    expect(stats.entries).toBe(42);
    expect(stats.config).toEqual({ enabled: false, ttlSeconds: 3600 });
    expect(stats.windowDays).toBe(7);
    expect(stats.recent).toEqual({ hits: 30, requests: 120, hitRate: 0.25, savedUsd: 1.5 });
    expect(countKeys).toHaveBeenCalledWith('nexus:respcache:*');
  });

  it('reports a 0 hit rate for an idle window rather than dividing by zero', async () => {
    countKeys.mockResolvedValue(0);
    queryRaw.mockResolvedValue([{ hits: 0, successes: 0, saved: null }]);

    const stats = await getCacheStats();

    expect(stats.recent.hitRate).toBe(0);
    expect(stats.recent.savedUsd).toBe(0);
  });

  it('survives an empty aggregate row', async () => {
    countKeys.mockResolvedValue(0);
    queryRaw.mockResolvedValue([]);

    const stats = await getCacheStats();

    expect(stats.recent).toEqual({ hits: 0, requests: 0, hitRate: 0, savedUsd: 0 });
  });
});

describe('purgeResponseCache', () => {
  it('deletes by the response-cache prefix and returns the count', async () => {
    deleteKeys.mockResolvedValue(7);

    expect(await purgeResponseCache()).toEqual({ deleted: 7 });
    expect(deleteKeys).toHaveBeenCalledWith('nexus:respcache:*');
  });
});
