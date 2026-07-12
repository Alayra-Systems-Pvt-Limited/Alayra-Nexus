import { describe, it, expect } from 'vitest';
import { extractModelIds } from './modelPath';

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
