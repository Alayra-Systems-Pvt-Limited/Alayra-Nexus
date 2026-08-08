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

// How often a key's `lastUsedAt` is actually written.
//
// ── What this column is for ───────────────────────────────────────────────────────────────────
//
// Routing orders candidate keys `lastUsedAt: 'asc'`, so the least recently used key is tried
// first and load spreads across a pool. It is NOT dead bookkeeping — dropping the write would
// freeze that ordering and concentrate traffic on whichever key happened to sort first.
//
// But it was being written on EVERY request: a database write on the hot path, and on Postgres a
// write is far more expensive than the read next to it. Two consecutive requests a millisecond
// apart do not need two writes to record "recently used".
//
// ── What the window costs ─────────────────────────────────────────────────────────────────────
//
// This is a real trade, not a free win, and it is worth stating precisely. Suppressing a write
// leaves the stored timestamp older than the truth, so a key in constant use can sort earlier than
// it deserves and be picked again. The error is bounded by the window: no key's recorded time can
// lag reality by more than `LAST_USED_WRITE_WINDOW_MS`.
//
// Five seconds is chosen because the RPM/TPM admission check — not this ordering — is what actually
// stops a key being overused. Ordering only breaks ties between keys that both have headroom, and a
// few seconds of skew there costs nothing. Set the window to 0 to restore a write per request.
//
// Per-process, deliberately. A scaled deployment writes at most once per window PER INSTANCE, which
// is more writes than a shared counter would allow but needs no coordination and cannot be wrong in
// a way that matters — the failure mode is an extra write, not a missed one.

/** Last time this process wrote each key, in epoch ms. */
const written = new Map<string, number>();

const DEFAULT_WINDOW_MS = 5_000;

function windowMs(): number {
  const raw = Number(process.env.LAST_USED_WRITE_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WINDOW_MS;
}

/**
 * Should this use of `keyId` be written through to the database?
 *
 * Returns true the first time a key is seen and then at most once per window. Records the decision
 * as a side effect, so callers must only ask when they are about to act on the answer.
 */
export function shouldWriteLastUsed(keyId: string, nowMs: number = Date.now()): boolean {
  const window = windowMs();
  if (window === 0) return true;

  const previous = written.get(keyId);
  if (previous !== undefined && nowMs - previous < window) return false;

  written.set(keyId, nowMs);
  return true;
}

/**
 * Forget a key, so its next use writes through immediately.
 *
 * Called when a key is deleted or its status changes, and by tests. Without it the map would grow
 * with every key the process ever routed to — bounded in practice by how many keys a deployment
 * has, which is tens, but unbounded in principle across a long-lived process and key rotation.
 */
export function forgetLastUsed(keyId?: string): void {
  if (keyId === undefined) written.clear();
  else written.delete(keyId);
}
