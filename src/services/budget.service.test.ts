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

// The service imports the real Redis/Prisma clients at module load; mock both so
// no connection is attempted and every data path is controlled by the test.
vi.mock('../lib/redis',  () => ({ redis:  { get: vi.fn(), set: vi.fn(), eval: vi.fn() } }));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { tokenUsage: { aggregate: vi.fn() } } }));

import { redis }  from '../lib/redis';
import { prisma } from '../lib/prisma';
import {
  periodKey, periodStart, periodEndSeconds, budgetRedisKey,
  getCurrentSpend, addSpend, checkTeamBudget, PERIOD_TTL_SECONDS,
} from './budget.service';

const rGet  = redis.get  as ReturnType<typeof vi.fn>;
const rSet  = redis.set  as ReturnType<typeof vi.fn>;
const rEval = redis.eval as ReturnType<typeof vi.fn>;
const pAgg  = (prisma.tokenUsage.aggregate as unknown) as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.clearAllMocks(); });

const at = (iso: string) => new Date(iso);

describe('period math (UTC)', () => {
  it('derives stable window keys', () => {
    const now = at('2026-07-09T15:30:00Z');
    expect(periodKey('monthly', now)).toBe('2026-07');
    expect(periodKey('daily',   now)).toBe('2026-07-09');
    expect(periodKey('weekly',  now)).toBe('2026-W28'); // 2026-07-09 is a Thursday of ISO week 28
  });

  it('handles the ISO year boundary (Dec 30 2024 belongs to 2025-W01)', () => {
    expect(periodKey('weekly', at('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });

  it('computes window starts', () => {
    const now = at('2026-07-09T15:30:00Z');
    expect(periodStart('monthly', now).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(periodStart('daily',   now).toISOString()).toBe('2026-07-09T00:00:00.000Z');
    expect(periodStart('weekly',  now).toISOString()).toBe('2026-07-06T00:00:00.000Z'); // Monday
  });

  it('computes seconds until the window resets', () => {
    const now = at('2026-07-09T23:59:00Z');
    expect(periodEndSeconds('daily', now)).toBe(60);
    expect(periodEndSeconds('monthly', now)).toBe(
      Math.ceil((Date.UTC(2026, 7, 1) - now.getTime()) / 1000),
    );
  });

  it('namespaces budget counters per team and window', () => {
    expect(budgetRedisKey('t1', '2026-07')).toBe('nexus:budget:t1:2026-07');
    expect(budgetRedisKey('t1', '2026-07')).not.toBe(budgetRedisKey('t2', '2026-07'));
  });
});

describe('getCurrentSpend', () => {
  it('returns the cached counter on a Redis hit', async () => {
    rGet.mockResolvedValue('3.25');
    expect(await getCurrentSpend('t1', 'monthly')).toBe(3.25);
    expect(pAgg).not.toHaveBeenCalled();
  });

  it('seeds from the TokenUsage sum on a miss (NX, with a period TTL)', async () => {
    rGet.mockResolvedValue(null);
    pAgg.mockResolvedValue({ _sum: { estimatedUsd: 7.5 } });
    const now = at('2026-07-09T12:00:00Z');
    expect(await getCurrentSpend('t1', 'monthly', now)).toBe(7.5);
    expect(rSet).toHaveBeenCalledWith(
      'nexus:budget:t1:2026-07', '7.5', 'EX', PERIOD_TTL_SECONDS.monthly, 'NX',
    );
  });

  it('treats an empty history as zero spend', async () => {
    rGet.mockResolvedValue(null);
    pAgg.mockResolvedValue({ _sum: { estimatedUsd: null } });
    expect(await getCurrentSpend('t1', 'daily')).toBe(0);
  });
});

describe('addSpend', () => {
  it('increments only an existing window counter (never seeds a stale partial)', async () => {
    await addSpend('t1', 'monthly', 0.02, at('2026-07-09T12:00:00Z'));
    expect(rEval).toHaveBeenCalledTimes(1);
    const [, , key, amount] = rEval.mock.calls[0];
    expect(key).toBe('nexus:budget:t1:2026-07');
    expect(amount).toBe('0.02');
  });

  it('ignores zero/negative amounts', async () => {
    expect(await addSpend('t1', 'monthly', 0)).toBeNull();
    expect(await addSpend('t1', 'monthly', -1)).toBeNull();
    expect(rEval).not.toHaveBeenCalled();
  });

  it('returns the new running total when the counter exists (for threshold detection)', async () => {
    rEval.mockResolvedValue('8.10'); // INCRBYFLOAT hands back a string
    expect(await addSpend('t1', 'monthly', 0.10)).toBe(8.1);
  });

  it('returns null when the counter does not exist yet (Lua declined to seed)', async () => {
    rEval.mockResolvedValue(null); // Lua false → null over RESP
    expect(await addSpend('t1', 'monthly', 0.10)).toBeNull();
  });
});

describe('checkTeamBudget', () => {
  it('always allows a team with no cap', async () => {
    const v = await checkTeamBudget('t1', null, 'monthly');
    expect(v.allowed).toBe(true);
    expect(rGet).not.toHaveBeenCalled();
  });

  it('allows under the cap and blocks at/over it (default action)', async () => {
    rGet.mockResolvedValueOnce('9.99');
    const under = await checkTeamBudget('t1', 10, 'monthly');
    expect(under.allowed).toBe(true);
    expect(under.downgrade).toBe(false);

    rGet.mockResolvedValueOnce('10');
    const blocked = await checkTeamBudget('t1', 10, 'monthly');
    expect(blocked.allowed).toBe(false);
    expect(blocked.downgrade).toBe(false);
    expect(blocked.spendUsd).toBe(10);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('"notify" is a soft cap: over budget but still admitted, never downgraded', async () => {
    rGet.mockResolvedValueOnce('25');
    const v = await checkTeamBudget('t1', 10, 'monthly', 'notify');
    expect(v.allowed).toBe(true);
    expect(v.downgrade).toBe(false);
    expect(v.spendUsd).toBe(25);
  });

  it('"downgrade" admits over-budget traffic and flags it for fast-tier routing', async () => {
    rGet.mockResolvedValueOnce('5');
    const under = await checkTeamBudget('t1', 10, 'monthly', 'downgrade');
    expect(under.allowed).toBe(true);
    expect(under.downgrade).toBe(false); // under budget: nothing changes yet

    rGet.mockResolvedValueOnce('12');
    const over = await checkTeamBudget('t1', 10, 'monthly', 'downgrade');
    expect(over.allowed).toBe(true);
    expect(over.downgrade).toBe(true);
  });
});
