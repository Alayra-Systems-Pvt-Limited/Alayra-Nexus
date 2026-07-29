import { describe, it, expect } from 'vitest';
import { bytes, compactNumber, currency, duration, relativeTime, shortDate } from './format';

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

describe('bytes', () => {
  it('climbs units and keeps one decimal until the number is big enough not to need it', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(150_000)).toBe('150 KB');
    expect(bytes(2_400_000)).toBe('2.4 MB');
    expect(bytes(3_000_000_000)).toBe('3.0 GB');
  });

  it('does not render a negative or non-finite size as one', () => {
    // A file size arrives from the browser; a wrong one should read as nothing, not as "-1 B".
    expect(bytes(-1)).toBe('0 B');
    expect(bytes(NaN)).toBe('0 B');
  });
});

describe('duration', () => {
  it('says one unit, rounded, because it is labelling an estimate', () => {
    expect(duration(1)).toBe('1 second');
    expect(duration(45)).toBe('45 seconds');
    expect(duration(90)).toBe('2 minutes');
    expect(duration(600)).toBe('10 minutes');
    expect(duration(3700)).toBe('1 hour');
    expect(duration(7800)).toBe('2 hours');
  });

  it('never says "0 seconds" — there is always at least a moment left', () => {
    // Rounding 0.4s down would put "0 seconds remaining" on screen while work is still happening,
    // which reads as a stuck progress bar rather than an imminent finish.
    expect(duration(0.4)).toBe('1 second');
  });

  it('returns nothing for a duration that cannot be described', () => {
    expect(duration(NaN)).toBe('');
    expect(duration(-5)).toBe('');
  });
});

describe('shortDate', () => {
  it('formats an ISO day as "Mon D" in UTC', () => {
    expect(shortDate('2026-07-09')).toBe('Jul 9');
    expect(shortDate('2026-12-25')).toBe('Dec 25');
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
