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

// The six aggregate queries run in one Promise.all, so the mock answers them in order.
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { $queryRaw: queryRaw } }));

import { getAnalyticsOverview } from './analytics.service';

/** Queue the six result sets in the order getAnalyticsOverview awaits them. */
function mockQueries(opts: {
  totals?: Record<string, unknown>;
  days?: Record<string, unknown>[];
  models?: Record<string, unknown>[];
  providers?: Record<string, unknown>[];
  modalities?: Record<string, unknown>[];
  outcomes?: Record<string, unknown>[];
}) {
  queryRaw
    .mockResolvedValueOnce(opts.totals ? [opts.totals] : [])
    .mockResolvedValueOnce(opts.days       ?? [])
    .mockResolvedValueOnce(opts.models     ?? [])
    .mockResolvedValueOnce(opts.providers  ?? [])
    .mockResolvedValueOnce(opts.modalities ?? [])
    .mockResolvedValueOnce(opts.outcomes   ?? []);
}

beforeEach(() => queryRaw.mockReset());

describe('getAnalyticsOverview — totals', () => {
  it('splits attempts into successes and errors and derives the success rate', async () => {
    mockQueries({
      totals: {
        requests: 100, successes: 90, inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
        estimatedUsd: 12.5, savedUsd: 3.25, cacheHits: 9, avgLatencyMs: 812.4, p95LatencyMs: 1999.6,
      },
    });
    const r = await getAnalyticsOverview('7d');
    expect(r.totals).toMatchObject({
      requests: 100, successes: 90, errors: 10, successRate: 0.9,
      estimatedUsd: 12.5, cacheSavedUsd: 3.25, cacheHits: 9,
    });
    // Cache hit rate is over successful requests — a failed request never had a cache to hit.
    expect(r.totals.cacheHitRate).toBeCloseTo(0.1);
    // Latency is rounded to whole milliseconds for display.
    expect(r.totals.avgLatencyMs).toBe(812);
    expect(r.totals.p95LatencyMs).toBe(2000);
  });

  it('reports a 0 success rate for an idle window rather than a flattering 100%', async () => {
    mockQueries({ totals: { requests: 0, successes: 0, cacheHits: 0 } });
    const r = await getAnalyticsOverview('7d');
    expect(r.totals.requests).toBe(0);
    expect(r.totals.successRate).toBe(0);
    expect(r.totals.cacheHitRate).toBe(0);
  });

  it('survives an empty result set without throwing', async () => {
    mockQueries({});
    const r = await getAnalyticsOverview('30d');
    expect(r.totals.requests).toBe(0);
    expect(r.totals.estimatedUsd).toBe(0);
    expect(r.byDay.length).toBeGreaterThan(0); // still a full, zero-filled window
  });

  it('treats a null SUM (no rows matched) as zero, never NaN', async () => {
    mockQueries({ totals: { requests: 0, successes: 0, cacheHits: 0, estimatedUsd: null, savedUsd: null, avgLatencyMs: null, p95LatencyMs: null } });
    const r = await getAnalyticsOverview('7d');
    expect(r.totals.estimatedUsd).toBe(0);
    expect(r.totals.cacheSavedUsd).toBe(0);
    expect(r.totals.avgLatencyMs).toBe(0);
  });
});

describe('getAnalyticsOverview — daily series', () => {
  it('fills quiet days with zeros so the window is never silently compressed', async () => {
    const until = new Date('2026-07-14T12:00:00.000Z');
    const since = new Date('2026-07-12T12:00:00.000Z');
    mockQueries({
      totals: { requests: 3, successes: 2, cacheHits: 1 },
      days: [{ day: new Date('2026-07-13T00:00:00.000Z'), requests: 3, successes: 2, usd: 1.5, savedUsd: 0.5, cacheHits: 1, avgLatencyMs: 700 }],
    });
    const r = await getAnalyticsOverview('7d', since, until);
    expect(r.byDay.map((d) => d.date)).toEqual(['2026-07-12', '2026-07-13', '2026-07-14']);
    expect(r.byDay[0]).toMatchObject({ requests: 0, errors: 0, usd: 0, savedUsd: 0 });
    expect(r.byDay[1]).toMatchObject({ requests: 3, successes: 2, errors: 1, usd: 1.5, savedUsd: 0.5, avgLatencyMs: 700 });
    expect(r.byDay[2]).toMatchObject({ requests: 0 });
  });
});

describe('getAnalyticsOverview — breakdowns', () => {
  it('maps model, provider, modality, and outcome rows', async () => {
    mockQueries({
      totals:     { requests: 5, successes: 4, cacheHits: 0 },
      models:     [{ model: 'gpt-4o', requests: 4, tokens: 900, usd: 2 }],
      providers:  [{ provider: 'openai', requests: 5, errors: 1, tokens: 900, usd: 2 }],
      modalities: [{ unit: 'token', requests: 3, quantity: 0, tokens: 900, usd: 2 }, { unit: 'image', requests: 1, quantity: 2, tokens: 0, usd: 0.08 }],
      outcomes:   [{ outcome: 'success', requests: 4 }, { outcome: 'upstream_error', requests: 1 }],
    });
    const r = await getAnalyticsOverview('7d');
    expect(r.byModel[0]).toEqual({ model: 'gpt-4o', requests: 4, tokens: 900, usd: 2 });
    expect(r.byProvider[0]).toEqual({ provider: 'openai', requests: 5, errors: 1, tokens: 900, usd: 2 });
    expect(r.byModality.map((m) => m.unit)).toEqual(['token', 'image']);
    expect(r.byOutcome).toEqual([{ outcome: 'success', requests: 4 }, { outcome: 'upstream_error', requests: 1 }]);
  });
});

describe('getAnalyticsOverview — period', () => {
  it('echoes the requested period back with the resolved window', async () => {
    mockQueries({ totals: { requests: 0, successes: 0, cacheHits: 0 } });
    const r = await getAnalyticsOverview('90d');
    expect(r.period).toBe('90d');
    expect(new Date(r.until).getTime()).toBeGreaterThan(new Date(r.since).getTime());
  });
});
