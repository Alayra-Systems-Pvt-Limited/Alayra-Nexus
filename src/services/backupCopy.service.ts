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

// The optional copy of a backup kept outside the gateway (Phase B2 / B3).
//
// ── Why this copies rather than exports twice ─────────────────────────────────────────────────
//
// The backup already exists, in the database, and it is the one the operator can download. Running
// a second export would produce a DIFFERENT file — different timestamp in the header, different
// ciphertext — so "the copy on my NAS" and "the copy I downloaded" would not be the same artifact,
// and no operator could reason about which one they were holding. It would also read the whole
// database twice for one nightly backup.
//
// So the stored backup is streamed out byte-for-byte. One export, one artifact, in as many places
// as the operator asked for.
//
// ── Why a failed copy does not fail the backup ────────────────────────────────────────────────
//
// The backup succeeded — it is in the database and it can be downloaded. An unreachable NAS is a
// real problem and it is reported as one, but turning it into "last night's backup failed" would be
// a lie that sends somebody looking in the wrong place. It is reported separately, and it is
// reported LOUDLY, because a second copy nobody knows stopped being written is the whole reason
// this feature is worth having.

import { pipeline } from 'node:stream/promises';
import { readStoredBackup, type StoredBackup } from '../lib/backup/backupStore';
import { destinationAdapter } from '../lib/backupDestination';
import { prunable, type BackupDestination } from '../lib/backupSchedule';

export interface CopyOutcome {
  copied: boolean;
  /** Where it went, for the dashboard and the audit trail. Absent when nothing was attempted. */
  destination?: string;
  /** Old copies removed at the destination to stay within the retention limit. */
  pruned?: number;
  error?: string;
}

/**
 * Write an already-stored backup to the off-machine destination.
 *
 * Retention runs only after a COMMITTED copy, for the same reason it does on the primary path:
 * deleting last week's copies because tonight's transfer failed is precisely the wrong response to
 * a failure, and it is what a "make room, then write" ordering would do.
 */
export async function copyOffMachine(
  backup: StoredBackup,
  destination: BackupDestination,
  keep: number,
): Promise<CopyOutcome> {
  const adapter = destinationAdapter(destination);

  try {
    await adapter.ensure();

    const sink = await adapter.begin(backup.filename);
    try {
      // `pipeline` propagates failures in both directions and destroys both ends on error, which is
      // what keeps a half-written file from being committed when the read side is what broke.
      await pipeline(readStoredBackup(backup.id), sink.out, { end: false });
    } catch (err) {
      await sink.abort();
      throw err;
    }
    await sink.commit();

    const doomed = prunable(await adapter.list(), keep);
    for (const name of doomed) {
      await adapter.remove(name).catch(() => { /* a copy that was made beats a tidy folder */ });
    }

    return { copied: true, destination: adapter.describe(), pruned: doomed.length };
  } catch (err) {
    return { copied: false, destination: adapter.describe(), error: (err as Error).message };
  }
}
