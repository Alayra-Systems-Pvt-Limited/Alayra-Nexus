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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetKeyRow, getKeyRow, setKeyRow, type CachedKeyRow } from './keyRowCache';

const TTL = 1_000;

const row = (over: Partial<CachedKeyRow> = {}): CachedKeyRow => ({
  id: 'k1', providerId: 'p1', status: 'active', ownerTeamId: null,
  maxUsers: 1000, rpmLimit: 60, tpmLimit: 100_000, encryptedKey: 'enc-k1',
  ...over,
});

beforeEach(() => forgetKeyRow());
afterEach(() => { delete process.env.KEY_ROW_CACHE_TTL_MS; forgetKeyRow(); });

describe('getKeyRow / setKeyRow', () => {
  it('returns undefined for a key it has never seen', () => {
    expect(getKeyRow('k1', 0)).toBeUndefined();
  });

  it('serves a stored row until the TTL', () => {
    setKeyRow('k1', row(), 0);
    expect(getKeyRow('k1', 0)).toEqual(row());
    expect(getKeyRow('k1', TTL - 1)).toEqual(row());
  });

  it('expires exactly at the TTL, not after it', () => {
    setKeyRow('k1', row(), 0);
    expect(getKeyRow('k1', TTL)).toBeUndefined();
  });

  it('distinguishes a cached absence from a cache miss', () => {
    // A pin to a deleted key would otherwise re-query on every single request forever — the one
    // case where a cache that only stores hits is worse than no cache at all.
    setKeyRow('k1', null, 0);
    expect(getKeyRow('k1', 0)).toBeNull();
    expect(getKeyRow('k2', 0)).toBeUndefined();
  });

  it('keeps keys apart', () => {
    setKeyRow('k1', row({ id: 'k1' }), 0);
    setKeyRow('k2', row({ id: 'k2', ownerTeamId: 'team-a' }), 0);
    expect(getKeyRow('k1', 0)?.ownerTeamId).toBeNull();
    expect(getKeyRow('k2', 0)?.ownerTeamId).toBe('team-a');
  });

  it('does not cache at all when the TTL is zero', () => {
    process.env.KEY_ROW_CACHE_TTL_MS = '0';
    setKeyRow('k1', row(), 0);
    expect(getKeyRow('k1', 0)).toBeUndefined();
  });

  it('honours a custom TTL', () => {
    process.env.KEY_ROW_CACHE_TTL_MS = '50';
    setKeyRow('k1', row(), 0);
    expect(getKeyRow('k1', 49)).toEqual(row());
    expect(getKeyRow('k1', 50)).toBeUndefined();
  });

  it('falls back to the default when the TTL is not a usable number', () => {
    // A typo must not silently mean "cache forever".
    process.env.KEY_ROW_CACHE_TTL_MS = 'forever';
    setKeyRow('k1', row(), 0);
    expect(getKeyRow('k1', TTL - 1)).toEqual(row());
    expect(getKeyRow('k1', TTL)).toBeUndefined();
  });
});

describe('forgetKeyRow', () => {
  it('drops a banned key before its TTL runs out', () => {
    // The reason every write path calls this. A banned key's credential may already be revoked
    // upstream, so waiting out even one second is worse than a query.
    setKeyRow('k1', row({ status: 'active' }), 0);
    forgetKeyRow('k1');
    expect(getKeyRow('k1', 1)).toBeUndefined();
  });

  it('leaves other keys alone', () => {
    setKeyRow('k1', row(), 0);
    setKeyRow('k2', row(), 0);
    forgetKeyRow('k1');
    expect(getKeyRow('k2', 1)).toEqual(row());
  });

  it('clears everything when called with no key', () => {
    setKeyRow('k1', row(), 0);
    setKeyRow('k2', row(), 0);
    forgetKeyRow();
    expect(getKeyRow('k1', 1)).toBeUndefined();
    expect(getKeyRow('k2', 1)).toBeUndefined();
  });
});
