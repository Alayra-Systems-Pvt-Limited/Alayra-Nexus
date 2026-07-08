import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { deriveRateLimitKey } from './rateLimitKey';

describe('deriveRateLimitKey (Phase 1 abuse guard)', () => {
  it('hashes the bearer token into a per-credential bucket', () => {
    const token = 'nx_secret_team_key_123';
    const expected = 'tk:' + createHash('sha256').update(token).digest('hex');
    expect(deriveRateLimitKey(`Bearer ${token}`, '1.2.3.4')).toBe(expected);
  });

  it('never exposes the raw token in the key', () => {
    const token = 'super-secret-value';
    const key = deriveRateLimitKey(`Bearer ${token}`, '1.2.3.4');
    expect(key).not.toContain(token);
    expect(key.startsWith('tk:')).toBe(true);
  });

  it('gives two different credentials two different buckets', () => {
    const a = deriveRateLimitKey('Bearer key-a', '1.2.3.4');
    const b = deriveRateLimitKey('Bearer key-b', '1.2.3.4');
    expect(a).not.toBe(b);
  });

  it('is deterministic for the same credential regardless of source IP', () => {
    const a = deriveRateLimitKey('Bearer same-key', '1.1.1.1');
    const b = deriveRateLimitKey('Bearer same-key', '9.9.9.9');
    expect(a).toBe(b);
  });

  it('falls back to the IP bucket when there is no auth header', () => {
    expect(deriveRateLimitKey(undefined, '8.8.8.8')).toBe('ip:8.8.8.8');
  });

  it('falls back to the IP bucket for a non-Bearer auth header', () => {
    expect(deriveRateLimitKey('Basic dXNlcjpwYXNz', '8.8.8.8')).toBe('ip:8.8.8.8');
  });
});
