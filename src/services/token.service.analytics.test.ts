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

// Isolate the analytics readers: they touch only `prisma`. Everything else token.service
// pulls in at import (redis-backed services) is stubbed so the module loads without a
// connection, and the DB shape is fully controlled by the test.
// Hoisted with the vi.mock factories that consume it.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    tokenUsage:   { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    nexusTeamKey: { findMany: vi.fn() },
    $queryRaw:    vi.fn(),
  },
}));
vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../lib/redis', () => ({ redis: {} }));
vi.mock('./notifications.service', () => ({ notificationsArmed: vi.fn(async () => false), notify: vi.fn(async () => {}) }));
vi.mock('./model.service',        () => ({ getModelRegistry: vi.fn(async () => []) }));
vi.mock('./usagePipeline',        () => ({ emit: vi.fn() }));
vi.mock('./budget.service',       () => ({ addSpend: vi.fn(async () => null), periodKey: vi.fn(() => 'w') }));
vi.mock('./audit.service',        () => ({ isUsageAnonymized: vi.fn(async () => false) }));

import {
  getUsageSummary, getUsageByTeamKey, getTimeSeriesByTeam, getTimeSeriesByModel, recordTokenUsage,
} from './token.service';
import { emit } from './usagePipeline';

beforeEach(() => { vi.clearAllMocks(); });

describe('getUsageSummary — aggregated in the database', () => {
  it('sums totals, groups by model/provider, buckets by day, and never scans all rows', async () => {
    prismaMock.tokenUsage.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _sum: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedUsd: 0.5 },
    });
    prismaMock.tokenUsage.groupBy
      .mockResolvedValueOnce([{ modelName: 'gpt', _count: { _all: 2 }, _sum: { inputTokens: 8, outputTokens: 4, totalTokens: 12, estimatedUsd: 0.4 } }])
      .mockResolvedValueOnce([{ provider: 'openai', _count: { _all: 3 }, _sum: { totalTokens: 15, estimatedUsd: 0.5 } }]);
    prismaMock.$queryRaw.mockResolvedValue([{ day: new Date('2026-07-09T00:00:00Z'), tokens: 15, inputTokens: 10, outputTokens: 5, requests: 3, usd: 0.5 }]);

    const out = await getUsageSummary('7d');

    expect(prismaMock.tokenUsage.findMany).not.toHaveBeenCalled();     // no unbounded in-memory scan
    expect(out.until).toBeDefined();                                    // Finding C: window is unambiguous
    expect(out.totals).toMatchObject({ requests: 3, totalTokens: 15, estimatedUsd: 0.5 });
    expect(out.byModel.gpt).toMatchObject({ tokens: 12, requests: 2 });
    expect(out.byProvider.openai).toMatchObject({ tokens: 15, requests: 3 });
    expect(out.byDay).toEqual([{ date: '2026-07-09', tokens: 15, inputTokens: 10, outputTokens: 5, requests: 3, usd: 0.5 }]);
  });

  it('treats an empty window as zeroes without throwing', async () => {
    prismaMock.tokenUsage.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedUsd: null } });
    prismaMock.tokenUsage.groupBy.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);

    const out = await getUsageSummary('30d');
    expect(out.totals).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0 });
    expect(out.byDay).toEqual([]);
  });
});

describe('getUsageByTeamKey — grouped, names resolved in one lookup', () => {
  it('sorts by total tokens desc and drops keys deleted since they logged usage', async () => {
    prismaMock.tokenUsage.groupBy.mockResolvedValue([
      { nexusTeamKeyId: 'k1', _count: { _all: 2 }, _sum: { inputTokens: 4, outputTokens: 2, totalTokens: 6, estimatedUsd: 0.2 } },
      { nexusTeamKeyId: 'k2', _count: { _all: 5 }, _sum: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedUsd: 0.5 } },
      { nexusTeamKeyId: 'gone', _count: { _all: 1 }, _sum: { inputTokens: 1, outputTokens: 0, totalTokens: 1, estimatedUsd: 0.01 } },
    ]);
    prismaMock.nexusTeamKey.findMany.mockResolvedValue([{ id: 'k1', name: 'Alpha' }, { id: 'k2', name: 'Beta' }]);

    const out = await getUsageByTeamKey('30d');
    expect(prismaMock.tokenUsage.findMany).not.toHaveBeenCalled();
    expect(out.map((r) => r.id)).toEqual(['k2', 'k1']); // desc by totalTokens; 'gone' filtered out
    expect(out[0]).toMatchObject({ name: 'Beta', totalTokens: 15, requests: 5 });
  });
});

describe('time series — built from a date_trunc query', () => {
  it('shapes the per-team series (teamKeyId is the real field; teamId is a legacy alias)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ day: new Date('2026-07-09T00:00:00Z'), teamKeyId: 'k1', teamName: 'Alpha', requests: 4, tokens: 12 }]);
    const out = await getTimeSeriesByTeam('7d');
    expect(out).toEqual([{ date: '2026-07-09', teamKeyId: 'k1', teamId: 'k1', teamName: 'Alpha', requests: 4, tokens: 12 }]);
  });

  it('shapes the per-model series', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ day: new Date('2026-07-09T00:00:00Z'), model: 'gpt', tokens: 9 }]);
    const out = await getTimeSeriesByModel('7d');
    expect(out).toEqual([{ date: '2026-07-09', model: 'gpt', tokens: 9 }]);
  });
});

describe('recordTokenUsage — cost estimation', () => {
  it('records $0 when the model is not in the registry (explicit fallback)', async () => {
    // getModelRegistry is mocked to return [], so no model ever matches.
    await recordTokenUsage({
      sessionId: 's1', modelId: 'unknown-id', modelName: 'unknown-model', provider: 'openai',
      inputTokens: 100, outputTokens: 50,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emit).mock.calls[0][0]).toMatchObject({ estimatedUsd: 0, modelName: 'unknown-model' });
  });
});
