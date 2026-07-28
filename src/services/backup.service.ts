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

// Backup and restore, wired to this gateway (Phase B1.3).
//
// The engine in lib/backup takes its client, engine and streams as arguments so it can be driven
// against two databases at once by the parity suite. This is the thin layer that binds it to the
// gateway actually running — and the place the filename is decided, since that is a product
// decision rather than an engine one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { prisma, dbEngine } from '../lib/prisma';
import { envInt } from '../lib/envNumber';
import { deleteKeys } from '../lib/redisScan';
import { drainAudit } from './audit.service';
import { drainUsage } from './usagePipeline';
import { MAINTENANCE_KEY, beginMaintenance, reportProgress, endMaintenance } from './maintenance.service';
import { writeBackup, type ExportSummary } from '../lib/backup/export';
import { readBackup, type RestoreMode, type RestoreResult } from '../lib/backup/restore';

/**
 * The gateway's own version, read once.
 *
 * `../../package.json` resolves from both `src/services` and `dist/services`, the same reasoning as
 * the DDL path in sqliteBootstrap. Never fatal: a backup whose manifest says "unknown" is still a
 * perfectly good backup, and refusing to take one because a version string could not be read would
 * be an absurd trade.
 */
function gatewayVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string })
      .version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What the downloaded file is called.
 *
 * The date is in the name because a directory of backups is otherwise unreadable, and it is the one
 * piece of metadata deliberately NOT inside the encrypted envelope — a filename is not a secret, and
 * an operator has to be able to tell last night's from last month's without typing a passphrase.
 */
export function backupFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `alayra-nexus-backup-${stamp}.nxb`;
}

/**
 * Write an encrypted backup of this gateway to `out`.
 *
 * `includeGatewayRecipient` also wraps the file key for this gateway, so it can be reopened without
 * the passphrase. Default false: a manual download leaves the building, and a second way in only
 * helps someone who already has the .env. The scheduler (B2) will pass true, because an unattended
 * job has nobody to type a passphrase — and the passphrase recipient is added regardless, so such a
 * backup still survives the machine.
 */
export function exportBackup(passphrase: string, out: Writable, includeGatewayRecipient = false): Promise<ExportSummary> {
  return writeBackup({
    client: prisma, engine: dbEngine, passphrase, out,
    gatewayVersion: gatewayVersion(), includeGatewayRecipient,
  });
}

export interface RestoreRequest {
  input: Readable;
  /** Omitted only on the unattended path, where the gateway opens its own backup. */
  passphrase?: string;
  mode: RestoreMode;
  dryRun: boolean;
  /**
   * How many rows the file holds, when the caller knows (A4).
   *
   * A backup states its own row count in the TRAILER, at the end of the file, so a restore cannot
   * know its total until it has already finished. A dry run reads the whole file and does know —
   * which is the flow the dashboard follows anyway. Without it the restore still reports rows
   * written, just with no percentage and no estimate.
   */
  expectedRows?: number | null;
}

export interface GatewayRestoreResult extends RestoreResult {
  /** KV entries removed once the restore committed. Zero for a dry run. */
  kvKeysCleared: number;
}

/**
 * KV keys that must SURVIVE a restore's wipe, by exact name (A2).
 *
 * The maintenance flag (A4) coordinates every instance of the gateway: it is what makes the proxy
 * answer 503 with a countdown instead of hanging while tables are locked. Wiping it partway through
 * the very restore it exists to announce would drop the gateway back into service mid-operation —
 * so the wipe spares it.
 *
 * Taken from maintenance.service rather than written out again: two literals that must agree is a
 * rename away from a restore that silently clears its own flag, and the failure would show up only
 * under a real restore on a real gateway. One constant cannot disagree with itself.
 */
export const KV_PRESERVED_ON_RESTORE: readonly string[] = [MAINTENANCE_KEY];

/** The AppSettings read-through cache. Five-minute TTL, so staleness is bounded but not free. */
const SETTINGS_CACHE_PATTERN = 'nexus:setting:*';

/**
 * How long a restore may take before it is rolled back (A3).
 *
 * Thirty minutes, not two. The old two-minute budget did not make a large restore slow, it made one
 * impossible — and it sat behind a two-gigabyte upload limit, so the gateway accepted files it could
 * never apply. Thirty minutes is roughly what that upload cap is worth at real insert rates, which
 * makes the two limits describe the same gateway for the first time.
 *
 * The floor exists because a zero or one-millisecond timeout is not a smaller budget, it is a
 * restore that cannot start; an operator reaching for this to make a restore *safer* should not be
 * able to make it impossible instead.
 *
 * This is where the policy lives rather than in lib/backup, because it is a product decision. The
 * engine keeps its own conservative fallback for callers that pass nothing — the parity suite.
 */
export const RESTORE_TIMEOUT_ENV = 'NEXUS_RESTORE_TIMEOUT_MS';
const DEFAULT_RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_RESTORE_TIMEOUT_MS = 1_000;

export function restoreTimeoutMs(): number {
  return envInt(RESTORE_TIMEOUT_ENV, DEFAULT_RESTORE_TIMEOUT_MS, { min: MIN_RESTORE_TIMEOUT_MS });
}

/**
 * Read a backup into this gateway. Throws — changing nothing — if anything is wrong with it.
 *
 * ── Why the buffers are drained FIRST ─────────────────────────────────────────────────────────
 *
 * `factoryReset` already does this, for a reason that applies here identically: the audit and usage
 * writers hold rows in memory and flush on a timer, so a row buffered before the restore would land
 * AFTER it, in a gateway it has no relationship with.
 *
 * For usage that is not merely untidy. `usagePipeline.flush()` catches every error and re-queues the
 * batch, so a TokenUsage row whose NexusTeamKey no longer exists after a `replace` fails its foreign
 * key, is re-queued, fails again — forever — until the buffer hits its cap and begins shedding NEW
 * usage. Draining first empties the buffer into the tables that are about to be replaced anyway,
 * which is exactly where those rows belong.
 *
 * Draining stops the flush timer; `recordAudit` restarts it (audit.service.ts:167) and the usage
 * pipeline does the same on its next record, so this is self-healing rather than a shutdown.
 *
 * ── Why the KV is cleared LAST, and only after a commit ───────────────────────────────────────
 *
 * Redis is not inside the database transaction and cannot be. Clearing before would sign every
 * operator out of a restore that then rolled back and changed nothing. So the wipe waits for the
 * commit, which leaves a window of milliseconds where a pre-restore session is live against
 * post-restore data. That window is unavoidable without a distributed transaction; it is
 * measured in milliseconds rather than the 12 hours a session TTL would otherwise allow.
 *
 * ── Why `merge` does not wipe ────────────────────────────────────────────────────────────────
 *
 * `merge` inserts what is missing and removes nothing: no account disappears, no token is revoked,
 * so no session becomes wrong. Signing everyone out of an operation defined as non-destructive
 * would contradict what it is. The one genuine staleness is the settings cache, which could hide a
 * newly merged setting for up to five minutes — so that alone is cleared, at no cost to anyone.
 */
export async function restoreBackup(req: RestoreRequest): Promise<GatewayRestoreResult> {
  // A dry run writes nothing, so there is nothing to protect it from and nothing to invalidate.
  if (!req.dryRun) await Promise.all([drainAudit(), drainUsage()]);

  // Maintenance mode covers `replace` only (A4).
  //
  // `replace` empties every table first, so from the moment it starts, anything the gateway serves
  // is either locked-and-hanging (PostgreSQL) or the old world about to vanish (SQLite, where WAL
  // lets readers carry on against the pre-transaction snapshot). Neither is fit to answer with.
  //
  // `merge` only inserts what is missing. Nothing it does makes existing data wrong to serve, so
  // refusing traffic through it would be an outage we chose rather than one we prevented. On SQLite
  // a long merge does still serialise other WRITES behind its transaction — a contention problem,
  // not a correctness one, and not something refusing traffic would fix.
  const announced = !req.dryRun && req.mode === 'replace';
  if (announced) await beginMaintenance('a backup is being restored', req.expectedRows ?? null);

  let result: RestoreResult;
  try {
    result = await readBackup({
      client: prisma, engine: dbEngine,
      passphrase: req.passphrase, input: req.input, mode: req.mode, dryRun: req.dryRun,
      // Without this the engine falls back to its own conservative default and the gateway's setting
      // would be a variable nobody reads — the fix looking done while changing nothing.
      timeoutMs: restoreTimeoutMs(),
      onProgress: announced
        // Fire and forget: this runs inside the write transaction, so awaiting a KV round trip per
        // batch would make every restore slower to report that it is slow.
        ? (rows) => { void reportProgress(rows).catch(() => { /* watcher */ }); }
        : undefined,
    });
  } catch (err) {
    // A failed restore must not leave the gateway refusing traffic. The flag's TTL is a backstop
    // for a killed process, not the mechanism for an ordinary error.
    if (announced) await endMaintenance().catch(() => { /* already refusing; TTL will clear it */ });
    throw err;
  }

  if (req.dryRun) return { ...result, kvKeysCleared: 0 };

  // Sessions, rate-limit counters, breaker state, budgets, cached settings and the response cache
  // all describe the gateway that just stopped existing.
  //
  // Sessions are the security half of this. `resolveSession` re-checks the database only when a
  // session carries a user id; the ones minted by an admin API token, by the pre-claim password, or
  // by SSO with no email claim carry only a role and are never re-validated. Without this wipe such
  // a session keeps its full role against wholly different data until its TTL expires.
  const kvKeysCleared = req.mode === 'replace'
    ? await deleteKeys('nexus:*', KV_PRESERVED_ON_RESTORE)
    : await deleteKeys(SETTINGS_CACHE_PATTERN);

  // AFTER the wipe, never before. The wipe deliberately spares the maintenance flag, so lowering it
  // first would open the gateway to traffic during the very moment every session and cache is being
  // invalidated — a window where a request could be served against half-cleared state.
  if (announced) await endMaintenance();

  return { ...result, kvKeysCleared };
}
