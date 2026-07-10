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
import { selectModels, tierRank, type SelectableModel } from './modelSelect';

const model = (over: Partial<SelectableModel>): SelectableModel => ({
  id: over.id ?? over.modelString ?? 'm',
  modelString: over.modelString ?? over.id ?? 'm',
  provider: 'anthropic',
  tier: 'standard',
  priority: 1,
  status: 'active',
  capabilities: ['chat'],
  ...over,
});

const opts = (over: Partial<Parameters<typeof selectModels>[1]> = {}) => ({
  capability: 'chat' as const,
  activeProviderSlugs: new Set(['anthropic', 'openai', 'google', 'groq']),
  priceOf: () => null,
  costWeight: 0,
  ...over,
});

describe('tierRank', () => {
  it('orders premium < standard < fast, unknown last', () => {
    expect(tierRank('premium')).toBeLessThan(tierRank('standard'));
    expect(tierRank('standard')).toBeLessThan(tierRank('fast'));
    expect(tierRank('nonsense')).toBeGreaterThan(tierRank('fast'));
  });
});

describe('selectModels — ordering', () => {
  it('puts a premium model ahead of a standard one regardless of priority', () => {
    const out = selectModels([
      model({ id: 'std', tier: 'standard', priority: 1 }),
      model({ id: 'prem', tier: 'premium', priority: 9 }),
    ], opts());
    expect(out.map(m => m.id)).toEqual(['prem', 'std']);
  });

  it('orders by ascending priority within a tier', () => {
    const out = selectModels([
      model({ id: 'c', tier: 'fast', priority: 3 }),
      model({ id: 'a', tier: 'fast', priority: 1 }),
      model({ id: 'b', tier: 'fast', priority: 2 }),
    ], opts());
    expect(out.map(m => m.id)).toEqual(['a', 'b', 'c']);
  });

  // The Sonnet-premium + Haiku-fast on one Anthropic key case the pool model blocked.
  it('serves two models from the same provider across tiers', () => {
    const out = selectModels([
      model({ id: 'haiku', modelString: 'claude-haiku', tier: 'fast', priority: 1 }),
      model({ id: 'sonnet', modelString: 'claude-sonnet', tier: 'premium', priority: 1 }),
    ], opts());
    expect(out.map(m => m.id)).toEqual(['sonnet', 'haiku']);
  });
});

describe('selectModels — filtering', () => {
  it('excludes paused and retired models', () => {
    const out = selectModels([
      model({ id: 'ok' }),
      model({ id: 'paused', status: 'paused' }),
      model({ id: 'retired', status: 'retired' }),
    ], opts());
    expect(out.map(m => m.id)).toEqual(['ok']);
  });

  it('excludes models that do not declare the requested capability', () => {
    const out = selectModels([
      model({ id: 'chat', capabilities: ['chat'] }),
      model({ id: 'embed', capabilities: ['embedding'] }),
    ], opts({ capability: 'embedding' }));
    expect(out.map(m => m.id)).toEqual(['embed']);
  });

  it('excludes a model whose provider has no active pool', () => {
    const out = selectModels([
      model({ id: 'has-pool', provider: 'anthropic' }),
      model({ id: 'no-pool', provider: 'openai' }),
    ], opts({ activeProviderSlugs: new Set(['anthropic']) }));
    expect(out.map(m => m.id)).toEqual(['has-pool']);
  });

  it('returns nothing when the registry is empty', () => {
    expect(selectModels([], opts())).toEqual([]);
  });

  it('supports a model declaring multiple capabilities', () => {
    const multi = model({ id: 'multi', capabilities: ['chat', 'completion'] });
    expect(selectModels([multi], opts({ capability: 'chat' }))).toHaveLength(1);
    expect(selectModels([multi], opts({ capability: 'completion' }))).toHaveLength(1);
    expect(selectModels([multi], opts({ capability: 'embedding' }))).toHaveLength(0);
  });
});

describe('selectModels — cost tiebreaker', () => {
  const priced = [
    model({ id: 'prem-dear',  tier: 'premium', priority: 1 }),
    model({ id: 'prem-cheap', tier: 'premium', priority: 2 }),
    model({ id: 'fast-cheap', tier: 'fast',    priority: 1 }),
  ];
  const priceOf = (m: SelectableModel) => ({ 'prem-dear': 10, 'prem-cheap': 1, 'fast-cheap': 0.1 }[m.id] ?? null);

  it('leaves priority order intact when cost weight is 0', () => {
    const out = selectModels(priced, opts({ priceOf, costWeight: 0 }));
    expect(out.map(m => m.id)).toEqual(['prem-dear', 'prem-cheap', 'fast-cheap']);
  });

  it('prefers the cheaper model within a tier, but never crosses a tier', () => {
    const out = selectModels(priced, opts({ priceOf, costWeight: 1 }));
    // cheaper premium moves ahead of dearer premium; fast still comes last.
    expect(out.map(m => m.id)).toEqual(['prem-cheap', 'prem-dear', 'fast-cheap']);
  });
});
