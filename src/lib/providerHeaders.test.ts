import { describe, it, expect } from 'vitest';
import { parseExtraHeaders, withExtraHeaders } from './providerHeaders';

describe('parseExtraHeaders', () => {
  it('parses a JSON object of string headers', () => {
    expect(parseExtraHeaders('{"anthropic-version":"2023-06-01","x-extra":"y"}'))
      .toEqual({ 'anthropic-version': '2023-06-01', 'x-extra': 'y' });
  });

  it('returns {} for null, empty, or invalid JSON', () => {
    expect(parseExtraHeaders(null)).toEqual({});
    expect(parseExtraHeaders('')).toEqual({});
    expect(parseExtraHeaders('not json')).toEqual({});
  });

  it('returns {} when the root is not a plain object', () => {
    expect(parseExtraHeaders('["a","b"]')).toEqual({});
    expect(parseExtraHeaders('"scalar"')).toEqual({});
    expect(parseExtraHeaders('42')).toEqual({});
  });

  it('drops non-string values and blank keys', () => {
    expect(parseExtraHeaders('{"a":"1","b":2,"c":true,"d":null,"e":{"n":1},"  ":"x"}'))
      .toEqual({ a: '1' });
  });

  it('caps the number of headers', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) many[`h${i}`] = String(i);
    expect(Object.keys(parseExtraHeaders(JSON.stringify(many))).length).toBe(20);
  });

  it('drops oversized values', () => {
    expect(parseExtraHeaders(JSON.stringify({ big: 'x'.repeat(2000), ok: 'v' }))).toEqual({ ok: 'v' });
  });
});

describe('withExtraHeaders', () => {
  it('lets system headers win over extra headers', () => {
    const merged = withExtraHeaders('{"Authorization":"attacker","x-ok":"1"}', { Authorization: 'Bearer real' });
    expect(merged).toEqual({ Authorization: 'Bearer real', 'x-ok': '1' });
  });

  it('returns just the system headers when there are no extras', () => {
    expect(withExtraHeaders(null, { Authorization: 'Bearer real' })).toEqual({ Authorization: 'Bearer real' });
  });
});
