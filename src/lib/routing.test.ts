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
import { effectivePrice, clampCostWeight, costOrder } from './routing';
import { normalizeModel } from '../services/model.service';

// Regression guard, and a lesson about how the original bug hid.
//
// The `effectivePrice` cases below this block assert the null path using hand-written literals
// like `{ displayName: 'mystery' }`. Those pass, and always did — but normalizeModel writes every
// price field as a number defaulting to 0, so a model that reaches routing NEVER looks like that.
// A stored unpriced model produced 0, not null, which under cheapest-first ordering made it the
// most attractive candidate in the registry: Nexus preferentially routed to the models whose cost
// it could not account for. The unit tests were green throughout.
//
// So these cases go through the real normalizer. Anything asserting routing behaviour on a model
// must, or it is testing a shape production cannot produce.
describe('effectivePrice on real registry models (not literals)', () => {
  const unpriced = normalizeModel({ id: 'm-unpriced', modelString: 'mistral-small-latest', provider: 'mistral' });
  const priced   = normalizeModel({ id: 'm-priced',   modelString: 'gpt-4o', provider: 'openai', inputCostPer1M: 2.5, outputCostPer1M: 10 });
  const free     = normalizeModel({ id: 'm-free',     modelString: 'ling-3.0-tiny:free', provider: 'openrouter', pricingSource: 'harvested' });

  const price = (m: unknown) => effectivePrice(m as Record<string, unknown>);

  it('is null for a model nobody has priced', () => {
    expect(unpriced.pricingSource).toBe('unset');
    expect(price(unpriced)).toBeNull();
  });

  it('is 0 — not null — for a model the provider published as free', () => {
    // OpenRouter's `:free` models publish pricing {prompt:"0"}. Genuinely free, genuinely known.
    // Collapsing this into "unpriced" would rank real free capacity last and nag about it forever.
    expect(price(free)).toBe(0);
  });

  it('is the real figure for a priced model', () => {
    expect(price(priced)).toBeCloseTo(0.0125);
  });

  it('ranks an unpriced model LAST under cheapest-first, not first', () => {
    const order = costOrder([priced, unpriced], price, 1).map((m) => m.id);
    expect(order).toEqual(['m-priced', 'm-unpriced']);
  });

  it('still ranks a genuinely free model first', () => {
    const order = costOrder([priced, free], price, 1).map((m) => m.id);
    expect(order).toEqual(['m-free', 'm-priced']);
  });

  it('puts free ahead of priced ahead of unknown, all three together', () => {
    const order = costOrder([unpriced, priced, free], price, 1).map((m) => m.id);
    expect(order).toEqual(['m-free', 'm-priced', 'm-unpriced']);
  });

  it('preserves a hand-priced legacy entry that predates pricingSource', () => {
    // Migration guard: an operator's existing priced model must not become "unpriced" on upgrade
    // and silently drop to last.
    const legacy = normalizeModel({ id: 'legacy', modelString: 'gpt-4o', provider: 'openai', inputPricePer1k: 0.003, outputPricePer1k: 0.015 });
    expect(legacy.pricingSource).toBe('manual');
    expect(price(legacy)).toBeCloseTo(0.018);
  });
});

describe('effectivePrice', () => {
  it('sums input + output per-1k pricing', () => {
    expect(effectivePrice({ inputPricePer1k: 0.003, outputPricePer1k: 0.015 })).toBeCloseTo(0.018);
  });

  it('accepts the per-1M format and normalizes it', () => {
    expect(effectivePrice({ inputCostPer1M: 3, outputCostPer1M: 15 })).toBeCloseTo(0.018);
  });

  it('treats a free model as price 0, not unpriced', () => {
    expect(effectivePrice({ inputPricePer1k: 0, outputPricePer1k: 0 })).toBe(0);
  });

  it('returns null when there is no pricing at all', () => {
    expect(effectivePrice({ displayName: 'mystery' })).toBeNull();
    expect(effectivePrice(undefined)).toBeNull();
    expect(effectivePrice(null)).toBeNull();
  });
});

describe('clampCostWeight', () => {
  it('clamps into [0,1]', () => {
    expect(clampCostWeight(-1)).toBe(0);
    expect(clampCostWeight(2)).toBe(1);
    expect(clampCostWeight(0.4)).toBe(0.4);
  });
  it('falls back to 0 for junk', () => {
    expect(clampCostWeight('nope')).toBe(0);
    expect(clampCostWeight(undefined)).toBe(0);
  });
});

describe('costOrder', () => {
  const items = [
    { name: 'a', price: 0.02 },
    { name: 'b', price: 0.001 },
    { name: 'c', price: 0.01 },
  ];
  const priceOf = (x: { price: number | null }) => x.price;
  const names = (arr: { name: string }[]) => arr.map((x) => x.name);

  it('leaves order unchanged at weight 0', () => {
    expect(names(costOrder(items, priceOf, 0))).toEqual(['a', 'b', 'c']);
  });

  it('sorts strictly cheapest-first at weight 1', () => {
    expect(names(costOrder(items, priceOf, 1))).toEqual(['b', 'c', 'a']);
  });

  it('interpolates between operator order and cost order', () => {
    // weight 0.5 blends; cheapest (b) should climb but the result stays stable/deterministic
    const out = names(costOrder(items, priceOf, 0.5));
    expect(out).toHaveLength(3);
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('a')); // cheap b beats pricey a
  });

  it('ranks unpriced providers last but keeps them (never drops)', () => {
    const withNull = [
      { name: 'a', price: 0.02 },
      { name: 'x', price: null },
      { name: 'b', price: 0.001 },
    ];
    const out = names(costOrder(withNull, priceOf, 1));
    expect(out).toEqual(['b', 'a', 'x']);
    expect(out).toContain('x');
  });

  it('does not mutate the input array', () => {
    const original = items.slice();
    costOrder(items, priceOf, 1);
    expect(items).toEqual(original);
  });

  it('clamps out-of-range weights', () => {
    expect(names(costOrder(items, priceOf, 5))).toEqual(['b', 'c', 'a']); // treated as 1
    expect(names(costOrder(items, priceOf, -3))).toEqual(['a', 'b', 'c']); // treated as 0
  });
});
