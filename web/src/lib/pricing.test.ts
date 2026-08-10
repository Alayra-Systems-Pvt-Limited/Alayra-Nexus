import { describe, it, expect } from 'vitest';
import { pricingSourceOf, isUnpriced } from './pricing';
import type { AiModel } from '../api';
import dataset from '../demo/dataset.json';

const m = (over: Partial<AiModel>) => over as Partial<AiModel>;

describe('pricingSourceOf', () => {
  it('takes a stated source at face value', () => {
    expect(pricingSourceOf(m({ pricingSource: 'harvested' }))).toBe('harvested');
    expect(pricingSourceOf(m({ pricingSource: 'catalog', inputCostPer1M: 5 }))).toBe('catalog');
  });

  it('ignores a value that is not a real source', () => {
    expect(pricingSourceOf(m({ pricingSource: 'nonsense' as AiModel['pricingSource'] }))).toBe('unset');
  });

  it('infers manual for a priced model with no stated source — matching the server', () => {
    // src/services/model.service.ts makes exactly this inference for entries written before the
    // field existed. Disagreeing here would flag models the gateway considers perfectly priced.
    expect(pricingSourceOf(m({ inputCostPer1M: 2.5, outputCostPer1M: 10 }))).toBe('manual');
    expect(pricingSourceOf(m({ imagePrice: 0.04 }))).toBe('manual');
  });

  it('counts the legacy per-1k format the cost helpers still tolerate', () => {
    expect(pricingSourceOf({ inputPricePer1k: 0.003 } as unknown as Partial<AiModel>)).toBe('manual');
  });

  it('infers unset only when nothing is priced anywhere', () => {
    expect(pricingSourceOf(m({ inputCostPer1M: 0, outputCostPer1M: 0 }))).toBe('unset');
    expect(pricingSourceOf(m({}))).toBe('unset');
  });
});

describe('isUnpriced', () => {
  it('is false for a model the provider published as free', () => {
    // Zero is a price. Warning about free models trains operators to dismiss the warning.
    expect(isUnpriced(m({ pricingSource: 'harvested', inputCostPer1M: 0, outputCostPer1M: 0 }))).toBe(false);
  });

  it('is true only when the cost genuinely cannot be computed', () => {
    expect(isUnpriced(m({ pricingSource: 'unset' }))).toBe(true);
    expect(isUnpriced(m({ inputCostPer1M: 0.5 }))).toBe(false);
  });
});

describe('the published demo fixture', () => {
  it('is not reported as unpriced', () => {
    // The demo's fake API serves this file verbatim, with no gateway in the path to normalize it,
    // and it was written before pricingSource existed. A naive `?? "unset"` put a "No price" badge
    // on every model on the public demo and had Analytics announce that ten priced models had no
    // price. This is the regression guard for the marketing surface.
    // Typed as Partial, not AiModel — the fixture predates `pricingSource` and genuinely lacks it.
    // Asserting the full type here would need a cast through `unknown`, which would hide the very
    // thing this test exists to prove.
    const models = (dataset as { models: { models: Partial<AiModel>[] } }).models.models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((x) => x.pricingSource === undefined)).toBe(true);

    const priced = models.filter((x) => (x.inputCostPer1M ?? 0) > 0 || (x.outputCostPer1M ?? 0) > 0);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.filter(isUnpriced)).toEqual([]);
  });
});
