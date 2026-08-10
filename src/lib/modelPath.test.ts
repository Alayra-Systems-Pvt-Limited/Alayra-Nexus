import { describe, it, expect } from 'vitest';
import { extractModelIds, extractModelMeta } from './modelPath';

describe('extractModelIds', () => {
  it('reads the OpenAI/Anthropic shape (data[].id)', () => {
    const json = { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] };
    expect(extractModelIds(json, 'data[].id')).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('defaults to data[].id when no path is given', () => {
    expect(extractModelIds({ data: [{ id: 'x' }] }, null)).toEqual(['x']);
    expect(extractModelIds({ data: [{ id: 'x' }] }, '')).toEqual(['x']);
  });

  it('reads a bare root array of objects ([].id)', () => {
    expect(extractModelIds([{ id: 'a' }, { id: 'b' }], '[].id')).toEqual(['a', 'b']);
  });

  it('reads a nested array and an alternate field (result.models[].name)', () => {
    const json = { result: { models: [{ name: 'm1' }, { name: 'm2' }] } };
    expect(extractModelIds(json, 'result.models[].name')).toEqual(['m1', 'm2']);
  });

  it('reads an array of plain strings (models[])', () => {
    expect(extractModelIds({ models: ['a', 'b'] }, 'models[]')).toEqual(['a', 'b']);
  });

  it('drops blanks and non-strings, and de-duplicates preserving order', () => {
    const json = { data: [{ id: 'a' }, { id: '' }, { id: 'a' }, { id: 42 }, { id: 'b' }] };
    expect(extractModelIds(json, 'data[].id')).toEqual(['a', 'b']);
  });

  it('returns [] when the path misses or the target is not an array', () => {
    expect(extractModelIds({ data: {} }, 'data[].id')).toEqual([]);
    expect(extractModelIds({ nope: [] }, 'data[].id')).toEqual([]);
    expect(extractModelIds(null, 'data[].id')).toEqual([]);
  });
});

describe('extractModelMeta', () => {
  it('harvests OpenRouter pricing and context, converting per-token to per-1M exactly', () => {
    // The precision case that matters: 0.0000025/token must become 2.5/1M, not 2.4999999….
    const json = {
      data: [{
        id: 'anthropic/claude-sonnet',
        name: 'Claude Sonnet',
        pricing: { prompt: '0.0000025', completion: '0.00001' },
        context_length: 128000,
      }],
    };
    expect(extractModelMeta(json, 'data[].id')).toEqual([{
      id: 'anthropic/claude-sonnet',
      name: 'Claude Sonnet',
      inputCostPer1M: 2.5,
      outputCostPer1M: 10,
      contextWindow: 128000,
    }]);
  });

  it('rejects the -1 dynamic-pricing sentinel, keeping the other side', () => {
    const json = { data: [{ id: 'm', pricing: { prompt: '-1', completion: '0.000001' } }] };
    expect(extractModelMeta(json, 'data[].id')).toEqual([{ id: 'm', outputCostPer1M: 1 }]);
  });

  it('KEEPS a published 0 — a free model is priced, not unpriced', () => {
    // OpenRouter's `:free` models publish exactly this. Dropping it (which this code used to do)
    // made every free model indistinguishable from one nobody has priced: flagged as unpriced in
    // the dashboard and ranked last by cost-based routing, forever. See per1M in modelPath.ts.
    const free = { data: [{ id: 'inclusionai/ling-3.0-tiny:free', pricing: { prompt: '0', completion: '0' } }] };
    expect(extractModelMeta(free, 'data[].id')).toEqual([
      { id: 'inclusionai/ling-3.0-tiny:free', inputCostPer1M: 0, outputCostPer1M: 0 },
    ]);
  });

  it('still distinguishes a free price from an absent one', () => {
    const absent = { data: [{ id: 'plain', object: 'model' }] };
    expect(extractModelMeta(absent, 'data[].id')).toEqual([{ id: 'plain' }]);
  });

  it('accepts numeric (not just string) pricing and ignores NaN garbage', () => {
    const json = { data: [{ id: 'n', pricing: { prompt: 0.000003, completion: 'soon' } }] };
    expect(extractModelMeta(json, 'data[].id')).toEqual([{ id: 'n', inputCostPer1M: 3 }]);
  });

  it('yields id-only entries for a plain OpenAI shape with no pricing', () => {
    const json = { data: [{ id: 'gpt-4o', object: 'model' }] };
    expect(extractModelMeta(json, 'data[].id')).toEqual([{ id: 'gpt-4o' }]);
  });

  it('falls back through context_window and max_context_length, flooring floats', () => {
    expect(extractModelMeta({ data: [{ id: 'a', context_window: 32768.9 }] }, 'data[].id'))
      .toEqual([{ id: 'a', contextWindow: 32768 }]);
    expect(extractModelMeta({ data: [{ id: 'b', max_context_length: 8192 }] }, 'data[].id'))
      .toEqual([{ id: 'b', contextWindow: 8192 }]);
    expect(extractModelMeta({ data: [{ id: 'c', context_length: 'big' }] }, 'data[].id'))
      .toEqual([{ id: 'c' }]);
  });

  it('uses display_name when name is absent', () => {
    const json = { data: [{ id: 'd', display_name: 'Model D' }] };
    expect(extractModelMeta(json, 'data[].id')).toEqual([{ id: 'd', name: 'Model D' }]);
  });

  it('keeps the FIRST occurrence of a duplicated id, with its metadata', () => {
    const json = { data: [
      { id: 'dup', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'dup', pricing: { prompt: '0.000009', completion: '0.000009' } },
    ] };
    expect(extractModelMeta(json, 'data[].id')).toEqual([
      { id: 'dup', inputCostPer1M: 1, outputCostPer1M: 2 },
    ]);
  });

  it('handles a bare string-array response as id-only entries', () => {
    expect(extractModelMeta({ models: ['a', 'b'] }, 'models[]'))
      .toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
