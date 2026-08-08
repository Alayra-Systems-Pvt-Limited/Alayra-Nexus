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
import { forgetKeyRow, getKeyList, getKeyRow, setKeyList, setKeyRow, type CachedKeyRow } from './keyRowCache';

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

describe('getKeyList / setKeyList', () => {
  it('returns undefined for a pool it has never seen', () => {
    expect(getKeyList('p1', null, 0)).toBeUndefined();
  });

  it('serves a stored list until the TTL, then stops', () => {
    setKeyList('p1', null, [row()], 0);
    expect(getKeyList('p1', null, TTL - 1)).toEqual([row()]);
    expect(getKeyList('p1', null, TTL)).toBeUndefined();
  });

  it('caches an EMPTY list, because "this pool has no eligible keys" is an answer', () => {
    // Not caching it would leave the query this exists to remove running on every request, for
    // exactly the pools that are cheapest to answer and most likely to be walked past.
    setKeyList('p1', null, [], 0);
    expect(getKeyList('p1', null, 1)).toEqual([]);
  });

  it('keeps a team list and the shared list apart — this is BYOK isolation', () => {
    // The whole reason ownerTeamId is part of the cache key. If a shared-pool caller could be served
    // a list built for a team, a private credential would leave its team through the cache. The
    // query enforces this with an equality filter; the cache must not undo it.
    const teamKey = row({ id: 'byok', ownerTeamId: 't1', encryptedKey: 'enc-private' });
    setKeyList('p1', 't1', [teamKey], 0);

    expect(getKeyList('p1', null, 1)).toBeUndefined();
    expect(getKeyList('p1', 't1', 1)).toEqual([teamKey]);
  });

  it('keeps two teams apart in the same pool', () => {
    setKeyList('p1', 't1', [row({ id: 'a', ownerTeamId: 't1' })], 0);
    setKeyList('p1', 't2', [row({ id: 'b', ownerTeamId: 't2' })], 0);
    expect(getKeyList('p1', 't1', 1)?.[0]?.id).toBe('a');
    expect(getKeyList('p1', 't2', 1)?.[0]?.id).toBe('b');
  });

  it('keeps the same owner apart across two pools', () => {
    setKeyList('p1', null, [row({ id: 'a' })], 0);
    setKeyList('p2', null, [row({ id: 'b' })], 0);
    expect(getKeyList('p1', null, 1)?.[0]?.id).toBe('a');
    expect(getKeyList('p2', null, 1)?.[0]?.id).toBe('b');
  });

  it('preserves the order it was given, because that order is the LRU rotation', () => {
    const ordered = [row({ id: 'oldest' }), row({ id: 'newer' })];
    setKeyList('p1', null, ordered, 0);
    expect(getKeyList('p1', null, 1)?.map((k) => k.id)).toEqual(['oldest', 'newer']);
  });

  it('is disabled by KEY_ROW_CACHE_TTL_MS=0, same as the row cache', () => {
    process.env.KEY_ROW_CACHE_TTL_MS = '0';
    setKeyList('p1', null, [row()], 0);
    expect(getKeyList('p1', null, 0)).toBeUndefined();
  });
});

describe('forgetKeyRow and the candidate lists', () => {
  it('clears the lists too, so a ban cannot survive in one', () => {
    // The failure this prevents: clearing the row but leaving the list would keep routing to the
    // banned key through the list, which is worse than having no cache at all.
    setKeyList('p1', null, [row({ id: 'k1' })], 0);
    forgetKeyRow('k1');
    expect(getKeyList('p1', null, 1)).toBeUndefined();
  });

  it('clears lists for pools the forgotten key was not even in', () => {
    // Deliberately wholesale. A key id does not identify which lists contain it, and the row that
    // would say may be the very thing being invalidated.
    setKeyList('p1', null, [row()], 0);
    setKeyList('p2', 't1', [row()], 0);
    forgetKeyRow('k-somewhere-else');
    expect(getKeyList('p1', null, 1)).toBeUndefined();
    expect(getKeyList('p2', 't1', 1)).toBeUndefined();
  });

  it('clears the lists when called with no key at all', () => {
    setKeyList('p1', null, [row()], 0);
    forgetKeyRow();
    expect(getKeyList('p1', null, 1)).toBeUndefined();
  });
});
