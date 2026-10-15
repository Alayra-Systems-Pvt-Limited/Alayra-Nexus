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

// What a request records (Phase 7.5): the outcome, the latency, and — for a cache hit — the cost
// that was avoided. Before 7.5 a cache hit stored a bare $0 and the counterfactual was lost, and a
// failed request stored nothing at all, which is why the dashboard could never show a success rate,
// an error mix, or cache savings.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const REGISTRY = [
  { id: 'openai-gpt-4o', modelString: 'gpt-4o', inputCostPer1M: 2.5, outputCostPer1M: 10 },
  { id: 'openai-tts',    modelString: 'tts-1',  speechPricePer1MChars: 15 },
];

vi.mock('../lib/redis', () => ({ redis: {} }));
vi.mock('./notifications.service', () => ({ notificationsArmed: vi.fn(async () => false), notify: vi.fn(async () => {}) }));
vi.mock('./model.service',        () => ({ getModelRegistry: vi.fn(async () => REGISTRY) }));
vi.mock('./usagePipeline',        () => ({ emit: vi.fn() }));
vi.mock('./budget.service',       () => ({ addSpend: vi.fn(async () => null), periodKey: vi.fn(() => 'w') }));
vi.mock('./usagePrivacy.service', () => ({ isUsageAnonymized: vi.fn(async () => false) }));

import { recordTokenUsage, recordOutcome } from './token.service';
import { emit } from './usagePipeline';
import { addSpend } from './budget.service';
import { notify } from './notifications.service';

const lastEvent = () => vi.mocked(emit).mock.calls[0][0];

// 1,000 input + 500 output on gpt-4o = (1000/1e6 × 2.5) + (500/1e6 × 10) = 0.0025 + 0.005 = 0.0075
const base = {
  sessionId: 's-1', modelId: 'openai-gpt-4o', modelName: 'gpt-4o', provider: 'openai',
  inputTokens: 1000, outputTokens: 500,
};

beforeEach(() => { vi.mocked(emit).mockReset(); vi.mocked(addSpend).mockReset(); vi.mocked(notify).mockClear(); });

describe('recordTokenUsage — a normal (uncached) request', () => {
  it('bills the model price and saves nothing', async () => {
    await recordTokenUsage({ ...base, latencyMs: 850 });
    expect(lastEvent()).toMatchObject({
      outcome: 'success', cached: false, latencyMs: 850,
      estimatedUsd: 0.0075, savedUsd: 0,
    });
  });

  it('rounds a fractional latency and never records a negative one', async () => {
    await recordTokenUsage({ ...base, latencyMs: -5 });
    expect(lastEvent().latencyMs).toBe(0);
  });

  it('defaults latency to 0 when the caller does not measure it', async () => {
    await recordTokenUsage({ ...base });
    expect(lastEvent().latencyMs).toBe(0);
  });
});

describe('recordTokenUsage — a cache hit', () => {
  it('costs nothing and records what the provider call would have cost', async () => {
    await recordTokenUsage({ ...base, cached: true, latencyMs: 4 });
    expect(lastEvent()).toMatchObject({
      outcome: 'success', cached: true, latencyMs: 4,
      estimatedUsd: 0,          // the provider was never called
      savedUsd: 0.0075,         // …and this is what calling it would have cost
    });
  });

  it('never charges a cache hit against the team budget', async () => {
    await recordTokenUsage({ ...base, cached: true, teamId: 't-1', teamBudgetPeriod: 'monthly', teamBudgetUsd: 10 });
    expect(addSpend).not.toHaveBeenCalled();
  });

  it('prices a non-token modality the same way (per-1M speech characters)', async () => {
    await recordTokenUsage({
      sessionId: 's-2', modelId: 'openai-tts', modelName: 'tts-1', provider: 'openai',
      inputTokens: 0, outputTokens: 0, unit: 'character', quantity: 2_000_000, cached: true,
    });
    expect(lastEvent()).toMatchObject({ cached: true, estimatedUsd: 0, savedUsd: 30 });
  });

  it('saves nothing when the model is not in the registry (no price to avoid)', async () => {
    await recordTokenUsage({ ...base, modelId: 'ghost', modelName: 'ghost', cached: true });
    expect(lastEvent()).toMatchObject({ estimatedUsd: 0, savedUsd: 0 });
  });
});

describe('recordTokenUsage — a stream that failed mid-flight', () => {
  it('still bills the partial tokens but is NOT booked as a success', async () => {
    // The provider delivered (and will bill for) partial output, so the tokens are real. Recording
    // it as "success" would quietly inflate the success rate; the caller stamps the true outcome.
    await recordTokenUsage({ ...base, outcome: 'upstream_error', latencyMs: 9000 });
    expect(lastEvent()).toMatchObject({
      outcome: 'upstream_error', estimatedUsd: 0.0075, inputTokens: 1000, outputTokens: 500,
    });
    // Exactly one row — the failure must not also be recorded separately.
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('recordOutcome — a request that did not succeed', () => {
  it('records the outcome and latency with no tokens, cost, or saving', async () => {
    await recordOutcome({ outcome: 'upstream_error', latencyMs: 1200, provider: 'openai', modelName: 'gpt-4o' });
    expect(lastEvent()).toMatchObject({
      outcome: 'upstream_error', latencyMs: 1200, provider: 'openai', modelName: 'gpt-4o',
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedUsd: 0, savedUsd: 0, cached: false,
    });
  });

  it('handles a failure that happened before routing, when no model or provider is known', async () => {
    await recordOutcome({ outcome: 'budget_blocked', latencyMs: 3 });
    expect(lastEvent()).toMatchObject({ outcome: 'budget_blocked', provider: '', modelName: '', estimatedUsd: 0 });
  });

  it('attributes the failure to the calling team key', async () => {
    await recordOutcome({ outcome: 'no_capacity', latencyMs: 7, nexusTeamKeyId: 'tk-1' });
    expect(lastEvent()).toMatchObject({ outcome: 'no_capacity', nexusTeamKeyId: 'tk-1' });
  });
});

// The row carries the caller's team itself (P1.1), so a host attributes usage to a hosted
// workspace without joining through a team key. The gateway's own master key has no team.
describe('usage rows carry the team', () => {
  it('a team request records its team id, success or failure', async () => {
    await recordTokenUsage({ ...base, nexusTeamKeyId: 'tk-1', teamId: 'team-1' });
    await recordOutcome({ outcome: 'client_error', latencyMs: 2, nexusTeamKeyId: 'tk-1', teamId: 'team-1' });
    expect(vi.mocked(emit).mock.calls.map(([row]) => row.teamId)).toEqual(['team-1', 'team-1']);
  });

  it('a master-key request records null, never an empty string', async () => {
    await recordTokenUsage({ ...base });
    await recordOutcome({ outcome: 'no_capacity', latencyMs: 2 });
    expect(vi.mocked(emit).mock.calls.map(([row]) => row.teamId)).toEqual([null, null]);
  });
});

// The team name arrives with the caller (P0.5a) instead of a team-table read inside the core, so
// a budget alert is worded the same way while the request path stays free of a database client.
describe('recordTokenUsage — a budget threshold alert', () => {
  // $8.00 spent of a $10 cap, reached by this request: the 80% line is crossed here.
  const crossing = { ...base, teamId: 't-1', teamBudgetPeriod: 'monthly', teamBudgetUsd: 10 };
  const alertTitle = async (): Promise<string> => {
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    return (vi.mocked(notify).mock.calls[0][0] as { title: string }).title;
  };

  it('names the team the caller resolved', async () => {
    vi.mocked(addSpend).mockResolvedValueOnce(8);
    await recordTokenUsage({ ...crossing, teamName: 'Growth' });
    expect(await alertTitle()).toContain('team "Growth" reached 80%');
  });

  it('falls back to the team id when the host sent no name', async () => {
    vi.mocked(addSpend).mockResolvedValueOnce(8);
    await recordTokenUsage(crossing);
    expect(await alertTitle()).toContain('team "t-1" reached 80%');
  });
});

// The extra token kinds (1.8.0) are recorded as reported and never priced, and a request that
// reports none writes exactly the row it wrote before they existed.
describe('usage rows carry the token kinds the provider reported', () => {
  const OLD_ROW_KEYS = [
    'id', 'sessionId', 'modelId', 'modelName', 'provider', 'inputTokens', 'outputTokens', 'totalTokens', 'unit',
    'quantity', 'estimatedUsd', 'outcome', 'latencyMs', 'cached', 'savedUsd', 'nexusTeamKeyId', 'teamId', 'createdAt',
  ];

  it('a request that reports none writes the same columns, and the same price, as before', async () => {
    await recordTokenUsage({ ...base });
    await recordTokenUsage({ ...base, detail: {} });
    for (const [row] of vi.mocked(emit).mock.calls) {
      expect(Object.keys(row).sort()).toEqual([...OLD_ROW_KEYS].sort());
      expect(row.estimatedUsd).toBe(0.0075);
    }
  });

  it('records each reported kind, and the price does not move', async () => {
    const detail = { cachedInputTokens: 900, cacheWriteTokens: 50, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, cacheMissTokens: 100, reasoningTokens: 0 };
    await recordTokenUsage({ ...base, detail });
    expect(lastEvent()).toMatchObject({ ...detail, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedUsd: 0.0075 });
  });

  it('copies only the known kinds, so a stray field can never fail the batch insert', async () => {
    await recordTokenUsage({ ...base, detail: { reasoningTokens: 3, bogus: 1 } as never });
    expect(lastEvent()).toMatchObject({ reasoningTokens: 3 });
    expect(lastEvent()).not.toHaveProperty('bogus');
  });
});
