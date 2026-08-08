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

// The pinned key's row, for one second.
//
// ── Why this is not the provider cache ────────────────────────────────────────────────────────
//
// Provider rows change when an operator edits a pool. Key rows change UNDERNEATH US, at runtime:
// the circuit breaker cools a key on a 429 or a 5xx, bans it on repeated auth failure, and an
// admin can rotate its credential or hand it to a team. Three of the fields here are ones we would
// rather not be wrong about even briefly:
//
//   status        a banned key must stop being used — its credential may already be revoked
//   ownerTeamId   BYOK isolation. A key just assigned to a team must not keep serving shared traffic
//   encryptedKey  a rotated key must not keep sending the credential it replaced
//
// So this is emphatically not "cache it for a minute and invalidate on write".
//
// ── One second, and why that is enough ────────────────────────────────────────────────────────
//
// The benefit does not come from holding the row for a long time. It comes from holding it across
// the requests that arrive while it is hot. A key serving 400 requests a second is read from the
// database once instead of four hundred times at a one-second TTL — about 99.75% of the queries
// removed — and 99.9% at two seconds. There is almost nothing left to buy by holding it longer,
// and the cost of holding it longer is measured in how wrong we can be.
//
// One second is therefore the WORST case, not the expected case: every write path below also
// invalidates explicitly, so within a single process a ban or a rotation takes effect immediately.
// The TTL exists for what explicit invalidation cannot reach — another instance's write, a change
// made directly in the database, a restore — and it bounds all of them to a second.
//
// Deliberately per-process rather than in the shared KV. Under Postgres and Redis, putting the row
// in Redis would trade a Postgres round trip for a Redis one, which is cheaper but not free; an
// in-process map costs nothing at all. The price is that another instance's write is invisible
// here, which is exactly what the TTL is sized to cover.
//
// Two live checks are unaffected either way and are worth remembering when judging the risk: the
// breaker gate is read from the KV, not from this row, and RPM/TPM admission is atomic in the KV.
// A stale row cannot get past either of them.
//
// LAST_KEY_ROW_TTL_MS=0 disables the cache entirely and restores a query per request.
//
// ── The candidate LIST, and why it lives in this file ─────────────────────────────────────────
//
// The above serves the sticky path, which asks for ONE key by id. The routing sweep asks a different
// question — every eligible key in a pool, least-recently-used first — and it asks it once per pool
// it tries. `bench:routing` measured the consequence: exactly one extra database query per exhausted
// pool walked, arriving when capacity is tight and the walk is deepest.
//
// So the list is cached too, on the same one-second terms. It is in this file rather than its own
// because the two caches hold the same rows and must be invalidated together: a ban that cleared the
// row but left the list would keep routing to the banned key through the list, which is worse than
// having no cache at all. One module owns cached NexusKey data, and `forgetKeyRow` clears both.
//
// ── What caching the ORDER costs ──────────────────────────────────────────────────────────────
//
// The list is ordered `lastUsedAt: 'asc'` so load spreads across a pool, and freezing it for a second
// means a key can be picked again when a fresher ordering would have moved on.
//
// That skew already exists and is already larger: `lib/lastUsed.ts` writes the column at most once
// per five-second window per key, so the stored ordering lags reality by up to five seconds by
// design. A one-second cache adds at most a fifth of the error the write window already accepts —
// and, as that file argues, ordering only breaks ties between keys that both have headroom. RPM/TPM
// admission is what actually stops a key being overused, and it is atomic in the KV, where no cache
// can reach it.

/** Exactly what sticky routing reads. Anything not here must not be served from this cache. */
export interface CachedKeyRow {
  id: string;
  providerId: string;
  status: string;
  ownerTeamId: string | null;
  maxUsers: number;
  rpmLimit: number;
  tpmLimit: number;
  encryptedKey: string;
}

interface Entry {
  /** null is cached too: a pin to a deleted key must not re-query on every request. */
  row: CachedKeyRow | null;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

interface ListEntry {
  rows: CachedKeyRow[];
  expiresAt: number;
}

/**
 * Candidate lists, keyed by pool AND owner.
 *
 * `ownerTeamId` is part of the key because it is what enforces BYOK isolation in the query — null
 * selects the shared pool, a team id selects only that team's private keys. Keying on the pool alone
 * would let a shared-pool caller be served a list built for a team, which is the one mistake this
 * cache must not make. `null` is encoded distinctly from any real id.
 */
const listCache = new Map<string, ListEntry>();

// An explicit marker for "no owner", and a separator that cannot appear inside a generated id,
// so no (pool, owner) pair can collide with another. A plain ':' would be fine today and would
// stop being fine the moment an id containing one appeared.
const SHARED = '(shared)';
const SEP = '|';

function listKey(providerId: string, ownerTeamId: string | null): string {
  return `${providerId}${SEP}${ownerTeamId ?? SHARED}`;
}

const DEFAULT_TTL_MS = 1_000;

function ttlMs(): number {
  const raw = Number(process.env.KEY_ROW_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * The cached row, or `undefined` when there is nothing usable.
 *
 * `undefined` means "ask the database"; a cached `null` means "asked, and there is no such key",
 * which is a different answer and is cached on purpose.
 */
export function getKeyRow(keyId: string, nowMs: number = Date.now()): CachedKeyRow | null | undefined {
  if (ttlMs() === 0) return undefined;

  const hit = cache.get(keyId);
  if (hit === undefined) return undefined;
  if (nowMs >= hit.expiresAt) { cache.delete(keyId); return undefined; }
  return hit.row;
}

export function setKeyRow(keyId: string, row: CachedKeyRow | null, nowMs: number = Date.now()): void {
  const ttl = ttlMs();
  if (ttl === 0) return;
  cache.set(keyId, { row, expiresAt: nowMs + ttl });
}

/**
 * The cached candidate list for a pool, or `undefined` when there is nothing usable.
 *
 * There is no cached empty-vs-absent distinction to make here: a pool with no eligible keys returns
 * an empty array, and caching that is right — it is an answer, and re-asking for it on every request
 * is exactly the query this exists to remove.
 */
export function getKeyList(
  providerId: string,
  ownerTeamId: string | null,
  nowMs: number = Date.now(),
): CachedKeyRow[] | undefined {
  if (ttlMs() === 0) return undefined;

  const hit = listCache.get(listKey(providerId, ownerTeamId));
  if (hit === undefined) return undefined;
  if (nowMs >= hit.expiresAt) { listCache.delete(listKey(providerId, ownerTeamId)); return undefined; }
  return hit.rows;
}

export function setKeyList(
  providerId: string,
  ownerTeamId: string | null,
  rows: CachedKeyRow[],
  nowMs: number = Date.now(),
): void {
  const ttl = ttlMs();
  if (ttl === 0) return;
  listCache.set(listKey(providerId, ownerTeamId), { rows, expiresAt: nowMs + ttl });
}

/**
 * Drop a key immediately, ahead of its expiry.
 *
 * Called from every path that writes a NexusKey row — the breaker's ban and cool, the probe
 * recovery, and the admin create/update/delete/reactivate routes. With no key, clears everything;
 * that is for tests and for wholesale replacements like a restore.
 *
 * The candidate lists are cleared WHOLESALE, whatever was passed. Two reasons, and the second is the
 * important one. A list is keyed by pool and owner, neither of which a key id gives us — the row
 * that would have told us may itself be the thing being invalidated. And a key CREATE has no cached
 * row to drop at all, yet must still reach the list, or a new key sits unused for a second while its
 * pool reports no headroom. Clearing a map with one entry per active pool costs nothing, and being
 * cheap is what lets it be unconditional; a targeted version would be faster and would eventually be
 * wrong in a way nothing here would catch.
 */
export function forgetKeyRow(keyId?: string): void {
  if (keyId === undefined) cache.clear();
  else cache.delete(keyId);
  listCache.clear();
}
