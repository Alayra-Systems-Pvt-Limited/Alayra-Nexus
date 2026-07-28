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

import { redis } from './redis';

// Pattern operations over the Redis keyspace, done the safe way. Both walk the keyspace with SCAN in
// bounded pages rather than KEYS — KEYS blocks the single-threaded server for the whole scan, which
// on a large cache would stall every other request. Kept out of redis.ts (which only owns the
// connection) so the loop can be unit-tested against a mocked client, the same way admission.ts is.

const SCAN_PAGE = 1000;

/**
 * Count the keys matching a glob pattern. The SCAN cursor is a string; '0' both begins the walk and,
 * when returned, signals the end. A page may legitimately be empty while the walk continues.
 */
export async function countKeys(pattern: string): Promise<number> {
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_PAGE);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}

/**
 * Delete every key matching a glob pattern, page by page, with UNLINK — which reclaims the memory on
 * a background thread so a large purge never blocks the event loop other requests share. Returns the
 * number of keys removed.
 *
 * `keep` names keys to spare, by EXACT name rather than by pattern (A2). Exact, because the only
 * caller that needs it — a restore wiping `nexus:*` — is sparing a specific coordination flag, and a
 * second glob would be a second thing that can be subtly too greedy. `glob.ts` already explains what
 * that costs when the pattern being matched decides what gets deleted.
 */
export async function deleteKeys(pattern: string, keep: readonly string[] = []): Promise<number> {
  const spared = new Set(keep);
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_PAGE);
    cursor = next;
    const doomed = spared.size === 0 ? keys : keys.filter((k) => !spared.has(k));
    if (doomed.length > 0) deleted += await redis.unlink(...doomed);
  } while (cursor !== '0');
  return deleted;
}
