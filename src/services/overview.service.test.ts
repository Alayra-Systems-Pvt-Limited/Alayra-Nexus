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

// The overview aggregate only composes other readers, so each one is mocked and this test asserts
// the shaping: stat mapping, the usable-key filter, the full-week gap fill, top-N ordering.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    tokenUsage: { aggregate: vi.fn() },
    nexusKey:   { findMany: vi.fn() },
    team:       { count: vi.fn() },
  },
}));
vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

const { getUsageSummary, getUsageByTeamKey, queryAuditLogs, getModelRegistry } = vi.hoisted(() => ({
  getUsageSummary:  vi.fn(),
  getUsageByTeamKey: vi.fn(),
  queryAuditLogs:   vi.fn(),
  getModelRegistry: vi.fn(),
}));
vi.mock('./token.service', () => ({ getUsageSummary, getUsageByTeamKey }));
vi.mock('./audit.service', () => ({ queryAuditLogs }));
vi.mock('./model.service', () => ({ getModelRegistry }));

import { getOverview } from './overview.service';

const NOW = new Date('2026-07-11T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  getUsageSummary.mockResolvedValue({
    totals:  { requests: 9, inputTokens: 120, outputTokens: 60, totalTokens: 180, estimatedUsd: 1.5 },
    byModel: {
      'gpt-4o': { tokens: 100, usd: 1.0, inputTokens: 70, outputTokens: 30, requests: 5 },
      'haiku':  { tokens: 80,  usd: 0.5, inputTokens: 50, outputTokens: 30, requests: 4 },
    },
    byProvider: {},
    byDay: [
      { date: '2026-07-11', tokens: 180, inputTokens: 120, outputTokens: 60, requests: 9, usd: 1.5 },
    ],
  });
  getUsageByTeamKey.mockResolvedValue([
    { id: 'k1', name: 'Alpha', totalTokens: 100, requests: 5, estimatedUsd: 1.0, inputTokens: 0, outputTokens: 0 },
  ]);
  queryAuditLogs.mockResolvedValue([
    { id: 'a1', action: 'keys.create', method: 'POST', actorRole: 'owner', status: 200, target: null, createdAt: new Date('2026-07-11T10:00:00Z') },
  ]);
  getModelRegistry.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
  prismaMock.tokenUsage.aggregate.mockResolvedValue({ _count: { _all: 42 }, _sum: { estimatedUsd: 7.25 } });
  prismaMock.team.count.mockResolvedValue(2);
});

describe('getOverview', () => {
  it('maps the headline stats from the composed readers', async () => {
    prismaMock.nexusKey.findMany.mockResolvedValue([]);
    const out = await getOverview(NOW);
    expect(out.stats).toEqual({
      totalRequests: 42, totalCostUsd: 7.25,
      inputTokens7d: 120, outputTokens7d: 60,
      activeKeys: 0, activeModels: 3, activeTeams: 2,
    });
  });

  it('counts a key as active only when it is active and not currently cooling', async () => {
    prismaMock.nexusKey.findMany.mockResolvedValue([
      { status: 'active', coolingUntil: null },                                  // usable
      { status: 'active', coolingUntil: new Date('2026-07-12T00:00:00Z') },      // cooling in future → not usable
      { status: 'active', coolingUntil: new Date('2026-07-01T00:00:00Z') },      // cooldown passed → usable
      { status: 'cooling', coolingUntil: null },                                 // not usable
      { status: 'banned', coolingUntil: null },                                  // not usable
    ]);
    const out = await getOverview(NOW);
    expect(out.stats.activeKeys).toBe(2);
  });

  it('fills the 7-day window, inserting zero days where there is no usage', async () => {
    prismaMock.nexusKey.findMany.mockResolvedValue([]);
    const out = await getOverview(NOW);
    expect(out.series7d).toHaveLength(7);
    expect(out.series7d[0].date).toBe('2026-07-05');   // oldest
    expect(out.series7d[6]).toMatchObject({ date: '2026-07-11', tokens: 180 }); // newest, real data
    expect(out.series7d[0]).toMatchObject({ tokens: 0, usd: 0, requests: 0 });  // gap filled
  });

  it('orders top models by tokens desc and normalises log timestamps to ISO strings', async () => {
    prismaMock.nexusKey.findMany.mockResolvedValue([]);
    const out = await getOverview(NOW);
    expect(out.topModels.map((m) => m.model)).toEqual(['gpt-4o', 'haiku']);
    expect(out.topKeys[0]).toMatchObject({ id: 'k1', name: 'Alpha', totalTokens: 100 });
    expect(out.recentLogs[0].createdAt).toBe('2026-07-11T10:00:00.000Z');
  });
});
