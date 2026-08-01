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
import { createHash } from 'crypto';
import { deriveRateLimitKey, ipBucket } from './rateLimitKey';

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

/**
 * GHSA-grpc-p53c-r64v (CVSS 7.3) — a rate limiter that keys on the verbatim client address does not
 * limit an IPv6 client at all. @fastify/rate-limit fixed this in 11.2.0 inside its own key
 * generator; this gateway supplies a custom one, so the upgrade alone would have closed the alert
 * and left the bypass. These tests are the half that proves the gateway is actually covered.
 *
 * The endpoint that cares is sign-in: unauthenticated, so it takes the IP path, and brute-force
 * protection is the entire reason a limit is on it.
 */
describe('ipBucket — an IPv6 client cannot mint itself unlimited buckets', () => {
  it('collapses every textual form of one address onto one bucket', () => {
    const forms = [
      '2001:db8::1',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
      '2001:DB8::1',
      '2001:db8:0:0::1',
      '2001:db8::1%eth0',
    ];
    const buckets = new Set(forms.map(ipBucket));
    // Without normalisation this Set has five members, and one attacker has five rate limits.
    expect(buckets.size).toBe(1);
  });

  it('puts a whole /64 in one bucket, however many addresses it rotates through', () => {
    const rotated = ['2001:db8:abcd:1234::1', '2001:db8:abcd:1234::dead:beef', '2001:db8:abcd:1234:ffff:ffff:ffff:ffff'];
    const buckets = new Set(rotated.map(ipBucket));
    // A single customer allocation is 2^64 addresses. It has to be worth one bucket, not 2^64.
    expect(buckets.size).toBe(1);
  });

  it('still separates genuinely different networks', () => {
    expect(ipBucket('2001:db8:abcd:1234::1')).not.toBe(ipBucket('2001:db8:abcd:9999::1'));
    expect(ipBucket('2001:db8::1')).not.toBe(ipBucket('2001:db9::1'));
  });

  it('leaves IPv4 exactly as it was', () => {
    expect(ipBucket('8.8.8.8')).toBe('8.8.8.8');
    expect(ipBucket('192.168.0.1')).toBe('192.168.0.1');
  });

  it('treats an IPv4-mapped address as the IPv4 address it is', () => {
    // Otherwise one host gets two buckets by choosing how to spell itself.
    expect(ipBucket('::ffff:8.8.8.8')).toBe('8.8.8.8');
    expect(ipBucket('::FFFF:8.8.8.8')).toBe('8.8.8.8');
  });

  it('returns anything unparseable unchanged instead of throwing', () => {
    // A malformed address still deserves a bucket; an exception here would disable the abuse guard
    // for every request, which is a worse outcome than an odd-looking key.
    expect(ipBucket('not:an:address:at:all:x:y:z:w:v')).toBe('not:an:address:at:all:x:y:z:w:v');
    expect(ipBucket('')).toBe('');
  });

  it('reaches the real key generator, not just this helper', () => {
    const a = deriveRateLimitKey(undefined, '2001:db8:abcd:1234::1');
    const b = deriveRateLimitKey(undefined, '2001:db8:abcd:1234::2');
    expect(a).toBe(b);
    expect(a).toBe('ip:2001:db8:abcd:1234::/64');
  });
});
