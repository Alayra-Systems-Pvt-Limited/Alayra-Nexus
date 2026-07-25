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

// The four aggregates run in one Promise.all, so the mock answers them in the order the service awaits:
// totals, byDay, byModel, members. getCurrentSpend (the current budget-window figure) is mocked apart.
const { queryRaw, findUnique, getCurrentSpend } = vi.hoisted(() => ({
  queryRaw: vi.fn(), findUnique: vi.fn(), getCurrentSpend: vi.fn(),
}));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { $queryRaw: queryRaw, team: { findUnique } } }));
vi.mock('./budget.service', () => ({ getCurrentSpend }));

import { getTeamStats } from './teamStats.service';

const team = {
  id: 't1', name: 'Frontend', status: 'active', assignedTier: 'standard',
  overBudgetAction: 'downgrade', budgetUsd: 100, budgetPeriod: 'monthly',
  _count: { teamKeys: 2 },
};

beforeEach(() => { queryRaw.mockReset(); findUnique.mockReset(); getCurrentSpend.mockReset(); });

describe('getTeamStats', () => {
  it('returns null for a team that does not exist', async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await getTeamStats('missing', '7d')).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('assembles totals, budget-window spend, and the member breakdown', async () => {
    findUnique.mockResolvedValueOnce(team);
    getCurrentSpend.mockResolvedValueOnce(42.5);
    queryRaw
      .mockResolvedValueOnce([{ requests: 10, successes: 9, totalTokens: 5000, estimatedUsd: 3.5, avgLatencyMs: 640.7 }])
      .mockResolvedValueOnce([{ day: new Date('2026-07-15T00:00:00Z'), requests: 10, usd: 3.5, tokens: 5000 }])
      .mockResolvedValueOnce([{ model: 'gpt-4o', requests: 8, tokens: 4000, usd: 3.0 }])
      .mockResolvedValueOnce([
        { id: 'k1', name: 'Abbas', maskedKey: 'nx_ab••••1234', requests: 8, tokens: 4000, usd: 3.0, lastUsedAt: new Date('2026-07-15T10:00:00Z') },
        { id: 'k2', name: 'CI',    maskedKey: 'nx_ci••••9876', requests: 0, tokens: 0,    usd: 0,   lastUsedAt: null },
      ]);

    const r = await getTeamStats('t1', '30d');
    expect(r).not.toBeNull();
    expect(r!.team).toMatchObject({ id: 't1', name: 'Frontend', overBudgetAction: 'downgrade', budgetSpendUsd: 42.5, keyCount: 2 });
    expect(r!.totals).toMatchObject({ requests: 10, successes: 9, errors: 1, totalTokens: 5000, estimatedUsd: 3.5 });
    expect(r!.totals.successRate).toBeCloseTo(0.9);
    expect(r!.totals.avgLatencyMs).toBe(641); // rounded for display
    // An idle key is kept in the breakdown (with zeros) rather than dropped.
    expect(r!.members).toHaveLength(2);
    expect(r!.members[1]).toMatchObject({ name: 'CI', requests: 0, usd: 0, lastUsedAt: null });
    expect(r!.byModel[0]).toMatchObject({ model: 'gpt-4o', requests: 8 });
  });

  it('reports a 0 success rate for an idle window rather than a flattering 100%', async () => {
    findUnique.mockResolvedValueOnce(team);
    getCurrentSpend.mockResolvedValueOnce(0);
    queryRaw
      .mockResolvedValueOnce([{ requests: 0, successes: 0, totalTokens: null, estimatedUsd: null, avgLatencyMs: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const r = await getTeamStats('t1', 'today');
    expect(r!.totals.requests).toBe(0);
    expect(r!.totals.successRate).toBe(0);
    expect(r!.totals.estimatedUsd).toBe(0);
    expect(r!.members).toEqual([]);
  });
});
