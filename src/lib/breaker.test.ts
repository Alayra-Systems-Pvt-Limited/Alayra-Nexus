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

// breaker.ts imports the real ioredis client, which connects (and throws when
// REDIS_URL is unset) at module load. These tests exercise the pure helpers and
// constants only; the Lua state machine is covered against a real Redis in the
// integration suite (Phase 13).
import { vi } from 'vitest';
vi.mock('./redis', () => ({ redis: { eval: vi.fn(), del: vi.fn(), incr: vi.fn(), expire: vi.fn(), multi: vi.fn() } }));

import {
  nextCooldown, strikesKey, cooldownKey, openKey, probeKey, authKey,
  BASE_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, STRIKE_THRESHOLD, AUTH_BAN_THRESHOLD,
} from './breaker';

describe('breaker key derivation', () => {
  it('namespaces each breaker facet per key id', () => {
    expect(strikesKey('k')).toBe('nexus:breaker:strikes:k');
    expect(cooldownKey('k')).toBe('nexus:breaker:cooldown:k');
    expect(openKey('k')).toBe('nexus:breaker:open:k');
    expect(probeKey('k')).toBe('nexus:breaker:probe:k');
    expect(authKey('k')).toBe('nexus:breaker:auth:k');
  });

  it('keeps every facet in a distinct namespace', () => {
    const keys = [strikesKey('x'), cooldownKey('x'), openKey('x'), probeKey('x'), authKey('x')];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('nextCooldown escalation', () => {
  it('starts at the base cooldown on the first trip', () => {
    expect(nextCooldown(0)).toBe(BASE_COOLDOWN_SECONDS);
  });

  it('doubles on each subsequent trip', () => {
    expect(nextCooldown(10)).toBe(20);
    expect(nextCooldown(20)).toBe(40);
    expect(nextCooldown(40)).toBe(80);
  });

  it('never exceeds the cap', () => {
    expect(nextCooldown(MAX_COOLDOWN_SECONDS)).toBe(MAX_COOLDOWN_SECONDS);
    expect(nextCooldown(MAX_COOLDOWN_SECONDS * 2)).toBe(MAX_COOLDOWN_SECONDS);
  });

  it('climbs from base to cap in a bounded number of steps', () => {
    let cd = 0;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) { cd = nextCooldown(cd); seen.push(cd); }
    expect(seen[0]).toBe(BASE_COOLDOWN_SECONDS);
    expect(seen[seen.length - 1]).toBe(MAX_COOLDOWN_SECONDS);
  });
});

describe('breaker thresholds', () => {
  it('trips on consecutive server failures, not a single blip', () => {
    expect(STRIKE_THRESHOLD).toBeGreaterThan(1);
  });

  it('bans a credential faster than it cools a transient fault', () => {
    expect(AUTH_BAN_THRESHOLD).toBeLessThanOrEqual(STRIKE_THRESHOLD);
  });
});
