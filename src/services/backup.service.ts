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
import { deleteKeys } from '../lib/redisScan';
import { drainAudit } from './audit.service';
import { drainUsage } from './usagePipeline';
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
 * so the wipe spares it, and A4 must use this exact key.
 */
export const KV_PRESERVED_ON_RESTORE: readonly string[] = ['nexus:maintenance'];

/** The AppSettings read-through cache. Five-minute TTL, so staleness is bounded but not free. */
const SETTINGS_CACHE_PATTERN = 'nexus:setting:*';

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

  const result = await readBackup({
    client: prisma, engine: dbEngine,
    passphrase: req.passphrase, input: req.input, mode: req.mode, dryRun: req.dryRun,
  });

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

  return { ...result, kvKeysCleared };
}
