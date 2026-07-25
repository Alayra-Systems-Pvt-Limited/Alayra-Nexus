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

vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { team: { findUnique: vi.fn(async () => null) } } }));
vi.mock('../lib/redis', () => ({ redis: {} }));
vi.mock('./notifications.service', () => ({ notificationsArmed: vi.fn(async () => false), notify: vi.fn(async () => {}) }));
vi.mock('./model.service',        () => ({ getModelRegistry: vi.fn(async () => REGISTRY) }));
vi.mock('./usagePipeline',        () => ({ emit: vi.fn() }));
vi.mock('./budget.service',       () => ({ addSpend: vi.fn(async () => null), periodKey: vi.fn(() => 'w') }));
vi.mock('./audit.service',        () => ({ isUsageAnonymized: vi.fn(async () => false) }));

import { recordTokenUsage, recordOutcome } from './token.service';
import { emit } from './usagePipeline';
import { addSpend } from './budget.service';

const lastEvent = () => vi.mocked(emit).mock.calls[0][0];

// 1,000 input + 500 output on gpt-4o = (1000/1e6 × 2.5) + (500/1e6 × 10) = 0.0025 + 0.005 = 0.0075
const base = {
  sessionId: 's-1', modelId: 'openai-gpt-4o', modelName: 'gpt-4o', provider: 'openai',
  inputTokens: 1000, outputTokens: 500,
};

beforeEach(() => { vi.mocked(emit).mockReset(); vi.mocked(addSpend).mockReset(); });

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
