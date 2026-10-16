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

import { describe, it, expect } from 'vitest';
import { readExtraPrices, serverToolPriced, tokenCost } from './usagePrice';

const sonnet = { inputCostPer1M: 3, outputCostPer1M: 15 };
const usd = (n: number) => Math.round(n * 1e9) / 1e9;

describe('tokenCost on Anthropic', () => {
  it('prices cache reads at 0.1x and 5-minute writes at 1.25x of the input price', () => {
    // 500 uncached + 120,000 read + 2,000 written (5m) = 122,500 input; 1,000 output.
    const cost = tokenCost(sonnet, 'anthropic', 122_500, 1_000,
      { cachedInputTokens: 120_000, cacheWriteTokens: 2_000, cacheWrite5mTokens: 2_000 });
    expect(usd(cost)).toBe(0.06);                                  // 0.036 + 0.0075 + 0.0015 + 0.015
  });

  it('prices 1-hour writes at 2x, and a write total with no split at the 1-hour rate', () => {
    expect(usd(tokenCost(sonnet, 'anthropic', 1_000, 0, { cacheWriteTokens: 1_000, cacheWrite1hTokens: 1_000 }))).toBe(0.006);
    expect(usd(tokenCost(sonnet, 'anthropic', 1_000, 0, { cacheWriteTokens: 1_000 }))).toBe(0.006);
    expect(usd(tokenCost(sonnet, 'anthropic', 1_000, 0, { cacheWriteTokens: 1_000, cacheWrite5mTokens: 400 })))
      .toBe(usd((400 * 3.75 + 600 * 6) / 1e6));
  });

  it('uses the registry\'s own cache prices where set', () => {
    const opus55 = { inputCostPer1M: 4, outputCostPer1M: 20, cacheReadCostPer1M: 0.2 };
    expect(usd(tokenCost(opus55, 'anthropic', 100_000, 0, { cachedInputTokens: 100_000 }))).toBe(0.02);
  });

  it('prices a request with no cache use exactly as before', () => {
    expect(usd(tokenCost(sonnet, 'anthropic', 10_000, 1_000))).toBe(usd(10_000 * 3 / 1e6 + 1_000 * 15 / 1e6));
  });
});

describe('tokenCost on every other provider', () => {
  it('keeps all input at the input price, cached or not, when the model sets no cache prices', () => {
    const gpt = { inputCostPer1M: 2.5, outputCostPer1M: 10 };
    expect(tokenCost(gpt, 'openai', 10_000, 100, { cachedInputTokens: 8_000 })).toBe(tokenCost(gpt, 'openai', 10_000, 100));
  });

  it('uses cache prices the operator set, and the input price for the ones left unset', () => {
    const gpt = { inputCostPer1M: 2, outputCostPer1M: 8, cacheReadCostPer1M: 0.5 };
    expect(usd(tokenCost(gpt, 'openai', 10_000, 0, { cachedInputTokens: 8_000, cacheWriteTokens: 1_000 })))
      .toBe(usd((1_000 * 2 + 8_000 * 0.5 + 1_000 * 2) / 1e6));
  });

  it('still reads the older per-1k fields', () => {
    expect(usd(tokenCost({ inputPricePer1k: 0.003, outputPricePer1k: 0.015 }, 'custom', 1_000, 1_000))).toBe(0.018);
  });
});

describe('server tools', () => {
  it('adds the per-use price of searches the provider reported, and nothing for an unpriced tool', () => {
    const m = { ...sonnet, webSearchCostPer1K: 10 };
    expect(usd(tokenCost(m, 'anthropic', 0, 0, undefined, { web_search_requests: 3, web_fetch_requests: 5 }))).toBe(0.03);
    expect(serverToolPriced(m, 'web_search')).toBe(true);
    expect(serverToolPriced(m, 'web_fetch')).toBe(false);
    expect(serverToolPriced({ ...m, webFetchCostPer1K: 0 }, 'web_fetch')).toBe(true);   // free, but priced
    expect(serverToolPriced(m, 'code_execution')).toBe(false);                         // not meterable at all
  });
});

describe('readExtraPrices', () => {
  it('keeps only real prices', () => {
    expect(readExtraPrices({ cacheReadCostPer1M: 0.3, cacheWrite5mCostPer1M: -1, cacheWrite1hCostPer1M: '6', webSearchCostPer1K: NaN }))
      .toEqual({ cacheReadCostPer1M: 0.3 });
  });
});
