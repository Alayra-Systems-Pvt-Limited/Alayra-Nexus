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

// Announcing a destructive operation instead of hanging through it (Phase A4).
//
// ── What this exists to stop ──────────────────────────────────────────────────────────────────
//
// A `replace` restore empties every table inside one transaction. On PostgreSQL that takes
// ACCESS EXCLUSIVE on every table and holds it until the restore commits, so the gateway does not
// get slow — it stops. Every proxy request has to read the key table, the key table is locked, and
// each caller hangs until something times out. From outside it is indistinguishable from a dead
// server, and nothing anywhere says why.
//
// SQLite has the opposite failure and it is arguably worse. WAL lets readers carry on against the
// pre-transaction snapshot, so the gateway keeps cheerfully serving with the OLD keys and the OLD
// budgets, then flips to the new data mid-flight. Not an outage. Silent.
//
// So: a flag every instance can see, set before the restore and cleared after it. While it is up,
// proxy traffic is refused with 503 and a Retry-After carrying the live estimate, and the dashboard
// can show a progress bar instead of a spinner that never resolves.
//
// ── Why the flag has a TTL, and why progress refreshes it ─────────────────────────────────────
//
// A flag that only a successful restore removes is a gateway that stays down forever if the process
// is killed mid-restore. The TTL is the self-healing part: five minutes without a progress update
// and the gateway resumes serving on its own. Every batch refreshes it, so a live restore never
// expires while a dead one always does.
//
// ── Why reads are cached in-process ───────────────────────────────────────────────────────────
//
// This is checked on every proxy request, and the answer is "no" essentially always. A round trip
// to Redis per request to learn that would be a permanent tax to cover a rare event. One second of
// staleness costs a handful of requests at the very start and end of a restore; the restore itself
// takes minutes.

import { redis } from '../lib/redis';

/**
 * Must match `KV_PRESERVED_ON_RESTORE` in backup.service.ts.
 *
 * A2 makes the restore's KV wipe spare this exact key. Without that, the restore would clear the
 * flag announcing itself and drop the gateway back into service partway through its own operation.
 */
export const MAINTENANCE_KEY = 'nexus:maintenance';

/** No progress for this long and the gateway assumes whatever set the flag has died. */
const TTL_SECONDS = 300;

/** How stale a hot-path answer may be. */
const CACHE_MS = 1_000;

/** At most one KV write a second, however fast rows are landing. */
const PROGRESS_WRITE_INTERVAL_MS = 1_000;

/** Below these, a rate is noise and an estimate built on it is a lie with a number in it. */
const MIN_ROWS_FOR_ETA = 1_000;
const MIN_ELAPSED_MS = 2_000;

/** What to tell a caller to do when there is no estimate yet. */
const RETRY_AFTER_UNKNOWN = 30;
const RETRY_AFTER_MIN = 5;
/**
 * Capped so a caller comes back and discovers recovery rather than sleeping through it. A restore
 * that finishes in three minutes should not have told everyone to wait half an hour.
 */
const RETRY_AFTER_MAX = 300;

export interface MaintenanceState {
  /** Why the gateway is unavailable, in words fit to show a caller. */
  reason: string;
  startedAt: number;
  rowsWritten: number;
  /**
   * Total rows to write, when it is known.
   *
   * Null unless a caller supplies it, and it usually can: the backup's own row count lives in the
   * TRAILER, at the end of the file, so a restore cannot know its own total until it has finished.
   * A dry run reads the whole file and does know, which is where the number comes from in practice.
   */
  rowsExpected: number | null;
  updatedAt: number;
}

export interface MaintenanceView extends MaintenanceState {
  elapsedMs: number;
  /** Null while the total is unknown — a progress bar with no denominator is a spinner. */
  percent: number | null;
  /** Null until enough has happened to estimate honestly. The UI shows "estimating…". */
  etaSeconds: number | null;
  /** What to put in Retry-After. Always a number: a caller needs to be told something. */
  retryAfterSeconds: number;
}

let cache: { at: number; state: MaintenanceState | null } | null = null;
let lastWriteAt = 0;

/** Drop the cached answer so this instance sees its own change immediately. */
function invalidate(): void {
  cache = null;
}

async function store(state: MaintenanceState): Promise<void> {
  await redis.set(MAINTENANCE_KEY, JSON.stringify(state), 'EX', TTL_SECONDS);
  cache = { at: Date.now(), state };
  lastWriteAt = Date.now();
}

/**
 * Raise the flag. Call before the destructive work starts, not after — the point is that nobody is
 * served stale or half-restored data, and a flag raised once the transaction is open is a flag
 * raised too late to matter.
 */
export async function beginMaintenance(reason: string, rowsExpected: number | null = null): Promise<void> {
  const now = Date.now();
  lastWriteAt = 0;
  await store({ reason, startedAt: now, rowsWritten: 0, rowsExpected, updatedAt: now });
}

/**
 * Report how far along the work is, refreshing the TTL as a side effect.
 *
 * Throttled: a restore inserting fifty thousand rows a second would otherwise write to the KV a
 * hundred times a second to move a number nobody is reading that fast.
 */
export async function reportProgress(rowsWritten: number): Promise<void> {
  const now = Date.now();
  if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;

  const current = cache?.state ?? (await load());
  if (!current) return;   // the flag expired or was cleared; nothing to update
  await store({ ...current, rowsWritten, updatedAt: now });
}

/**
 * Lower the flag. Belongs in a `finally`: a restore that threw must not leave the gateway refusing
 * traffic, and the TTL is a backstop rather than the mechanism.
 */
export async function endMaintenance(): Promise<void> {
  invalidate();
  await redis.del(MAINTENANCE_KEY);
  cache = { at: Date.now(), state: null };
}

async function load(): Promise<MaintenanceState | null> {
  const raw = await redis.get(MAINTENANCE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as MaintenanceState;
    // A malformed flag must not take the gateway down. Treating it as absent is the safe direction:
    // the worst case is serving during a restore, which is what happens without this feature at all.
    return typeof parsed?.startedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** The current state, or null when the gateway is serving normally. Cached for CACHE_MS. */
export async function readMaintenance(): Promise<MaintenanceView | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.state ? view(cache.state) : null;

  const state = await load();
  cache = { at: now, state };
  return state ? view(state) : null;
}

/** Test seam: forget the cached answer. */
export function resetMaintenanceCache(): void {
  cache = null;
  lastWriteAt = 0;
}

function view(state: MaintenanceState): MaintenanceView {
  const elapsedMs = Math.max(0, Date.now() - state.startedAt);

  const percent = state.rowsExpected && state.rowsExpected > 0
    ? Math.min(100, Math.floor((state.rowsWritten / state.rowsExpected) * 100))
    : null;

  // An estimate is offered only once there is a rate worth extrapolating. The first seconds of a
  // restore would otherwise produce "4 seconds remaining" for the next four minutes, which is worse
  // than saying nothing — a wrong number is believed, a missing one is waited out.
  let etaSeconds: number | null = null;
  if (
    state.rowsExpected && state.rowsExpected > state.rowsWritten &&
    state.rowsWritten >= MIN_ROWS_FOR_ETA && elapsedMs >= MIN_ELAPSED_MS
  ) {
    const msPerRow = elapsedMs / state.rowsWritten;
    etaSeconds = Math.max(1, Math.ceil((msPerRow * (state.rowsExpected - state.rowsWritten)) / 1000));
  }

  const retryAfterSeconds = Math.min(
    RETRY_AFTER_MAX,
    Math.max(RETRY_AFTER_MIN, etaSeconds ?? RETRY_AFTER_UNKNOWN),
  );

  return { ...state, elapsedMs, percent, etaSeconds, retryAfterSeconds };
}
