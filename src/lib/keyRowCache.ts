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
 * Drop a key immediately, ahead of its expiry.
 *
 * Called from every path that writes a NexusKey row — the breaker's ban and cool, the probe
 * recovery, and the admin create/update/delete/reactivate routes. With no key, clears everything;
 * that is for tests and for wholesale replacements like a restore.
 */
export function forgetKeyRow(keyId?: string): void {
  if (keyId === undefined) cache.clear();
  else cache.delete(keyId);
}
