import { describe, it, expect } from 'vitest';
import { compactNumber, currency, relativeTime } from './format';

describe('compactNumber', () => {
  it('shows small numbers as-is and abbreviates large ones', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1200)).toBe('1.2K');
    expect(compactNumber(4_500_000)).toBe('4.5M');
    expect(compactNumber(2_000_000_000)).toBe('2B');
  });
});

describe('currency', () => {
  it('is honest about zero and tiny non-zero spend', () => {
    expect(currency(0)).toBe('$0');
    expect(currency(0.004)).toBe('<$0.01');
    expect(currency(12.5)).toBe('$12.50');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-07-11T12:00:00Z').getTime();
  it('bucketises recent times and falls back to a date past a week', () => {
    expect(relativeTime('2026-07-11T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-07-11T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-07-11T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-07-09T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('2026-06-01T12:00:00Z', now)).toBe('2026-06-01');
  });
});
