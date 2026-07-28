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

/** Read a backup into this gateway. Throws — changing nothing — if anything is wrong with it. */
export function restoreBackup(req: RestoreRequest): Promise<RestoreResult> {
  return readBackup({
    client: prisma, engine: dbEngine,
    passphrase: req.passphrase, input: req.input, mode: req.mode, dryRun: req.dryRun,
  });
}
