/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── The money on the trace is the money in the row ────────────────────────────────────────────
//
// `recordTokenUsage` is the only place a price is worked out. The Playground could have computed
// its own from the model and the token counts — the arithmetic is not hard — and would then have
// shown a figure that agreed with the invoice right up until one of the two changed. So the
// function that records the cost stamps the trace with the same number, and this asserts it is the
// same number rather than a similar one.
//
// The `priced` flag is the other half, and it is the one that would go unnoticed. A model nobody
// has priced computes to $0.00, and so does a genuinely free one. A panel that renders both as
// `$0.0000` reports a total lower than the truth as though it were the truth — the exact defect
// P0c surfaced in Analytics, arriving somewhere new.
//
// This is the first test file `token.service.ts` has. It covers the stamping, not the service.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registry: Array<Record<string, unknown>> = [];
vi.mock('./model.service', () => ({ getModelRegistry: vi.fn(async () => registry) }));

vi.mock('../lib/prisma', () => ({
  dbEngine: 'postgres',
  prisma: {
    tokenUsage:  { create: vi.fn(async () => ({})) },
    appSettings: { findUnique: vi.fn(async () => null) },
  },
}));
// Reached via `isUsageAnonymized`, which reads a setting. Nothing to do with pricing, and stubbing
// it is what keeps this file about the one thing it is about.
vi.mock('./audit.service', () => ({ isUsageAnonymized: vi.fn(async () => false) }));
vi.mock('./usagePipeline',        () => ({ emit: vi.fn() }));
vi.mock('./budget.service',       () => ({ addSpend: vi.fn(async () => 0), periodKey: () => 'k' }));
vi.mock('./notifications.service', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('../lib/notify', () => ({
  budgetThresholdCrossed: () => null, budgetThresholdMessage: () => ({ title: '', body: '' }),
}));

import { recordTokenUsage } from './token.service';
import { newTrace }         from '../lib/requestTrace';

/** A trace as the proxy hands one over: usage present, money not yet known. */
function tracedRequest() {
  const trace = newTrace();
  trace.usage = { inputTokens: 1000, outputTokens: 500, estimatedUsd: null, savedUsd: null };
  return trace;
}

const BASE = {
  sessionId: 's-1', modelId: 'm-1', modelName: 'claude-sonnet-4-5', provider: 'anthropic',
  inputTokens: 1000, outputTokens: 500,
};

beforeEach(() => {
  vi.clearAllMocks();
  registry.length = 0;
});

describe('a model with a known price', () => {
  beforeEach(() => {
    registry.push({
      id: 'm-1', modelString: 'claude-sonnet-4-5',
      inputCostPer1M: 3, outputCostPer1M: 15, pricingSource: 'catalog',
    });
  });

  it('stamps what the request cost', async () => {
    const trace = tracedRequest();
    await recordTokenUsage(BASE, trace);

    // 1000 in at $3/M + 500 out at $15/M = $0.003 + $0.0075
    expect(trace.usage!.estimatedUsd).toBeCloseTo(0.0105, 6);
    expect(trace.usage!.savedUsd).toBe(0);
  });

  it('says the price is known', async () => {
    const trace = tracedRequest();
    await recordTokenUsage(BASE, trace);
    expect(trace.usage!.priced).toBe(true);
  });

  it('books a cache hit as a saving, not a cost', async () => {
    // The provider was never called, so it cost nothing — and the same figure is what the cache
    // saved. Both halves matter: a hit that reports a cost overstates spend, and one that reports
    // no saving makes "what has the cache saved me" unanswerable.
    const trace = tracedRequest();
    await recordTokenUsage({ ...BASE, cached: true }, trace);

    expect(trace.usage!.estimatedUsd).toBe(0);
    expect(trace.usage!.savedUsd).toBeCloseTo(0.0105, 6);
  });
});

describe('a model nobody has priced', () => {
  beforeEach(() => {
    registry.push({
      id: 'm-1', modelString: 'claude-sonnet-4-5',
      inputCostPer1M: 0, outputCostPer1M: 0, pricingSource: 'unset',
    });
  });

  it('is $0.00 and says so is not the same as free', async () => {
    const trace = tracedRequest();
    await recordTokenUsage(BASE, trace);

    expect(trace.usage!.estimatedUsd).toBe(0);
    // THE assertion. Without this the Playground shows `$0.0000` for a model whose cost is simply
    // unknown, and an operator reads it as free.
    expect(trace.usage!.priced).toBe(false);
  });
});

describe('a model that is genuinely free', () => {
  beforeEach(() => {
    registry.push({
      id: 'm-1', modelString: 'claude-sonnet-4-5',
      inputCostPer1M: 0, outputCostPer1M: 0, pricingSource: 'catalog',
    });
  });

  it('is $0.00 and known to be', async () => {
    // The other side of the pair above: same number, different claim, and the flag is what carries
    // the difference.
    const trace = tracedRequest();
    await recordTokenUsage(BASE, trace);

    expect(trace.usage!.estimatedUsd).toBe(0);
    expect(trace.usage!.priced).toBe(true);
  });
});

describe('a model that is not in the registry at all', () => {
  it('is unpriced rather than free', async () => {
    const trace = tracedRequest();
    await recordTokenUsage(BASE, trace);

    expect(trace.usage!.estimatedUsd).toBe(0);
    expect(trace.usage!.priced).toBe(false);
  });
});

describe('callers that do not want a trace', () => {
  it('records exactly as before when none is passed', async () => {
    registry.push({ id: 'm-1', modelString: 'claude-sonnet-4-5', inputCostPer1M: 3, outputCostPer1M: 15, pricingSource: 'catalog' });
    // The whole request path calls it this way. It must not throw, and must not require a trace.
    await expect(recordTokenUsage(BASE)).resolves.toBeUndefined();
  });

  it('does not invent a usage block on a trace that has none', async () => {
    // A trace from a request refused before any provider was called has no `usage`. Creating one
    // here would report token counts for a request that never ran.
    const trace = newTrace();
    await recordTokenUsage(BASE, trace);
    expect(trace.usage).toBeUndefined();
  });
});
