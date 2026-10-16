import { describe, it, expect } from 'vitest';
import { extraText, extraValues } from './ExtraPriceFields';

describe('the optional price boxes', () => {
  it('show a blank box for a price that is not set, never 0', () => {
    expect(extraText({ cacheReadCostPer1M: 0.3 })).toEqual({
      cacheReadCostPer1M: '0.3', cacheWrite5mCostPer1M: '', cacheWrite1hCostPer1M: '', webSearchCostPer1K: '', webFetchCostPer1K: '',
    });
    expect(extraText({ webSearchCostPer1K: 10 }, true)).toEqual({ webSearchCostPer1K: '10' });
  });

  it('save a blank box as unset, and a typed 0 as a real price of 0', () => {
    const v = extraValues({ cacheReadCostPer1M: '', webFetchCostPer1K: '0', webSearchCostPer1K: '10', cacheWrite1hCostPer1M: '-2' });
    expect(v.cacheReadCostPer1M).toBeUndefined();
    expect(v.webFetchCostPer1K).toBe(0);
    expect(v.webSearchCostPer1K).toBe(10);
    expect(v.cacheWrite1hCostPer1M).toBeUndefined();
    expect(JSON.parse(JSON.stringify(v))).toEqual({ webFetchCostPer1K: 0, webSearchCostPer1K: 10 });
  });
});
