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
