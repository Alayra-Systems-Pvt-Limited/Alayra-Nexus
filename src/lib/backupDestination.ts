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

// Where a scheduled backup is written (Phase B2), and the seam B3 extends.
//
// ── Why a file is never written under its final name ──────────────────────────────────────────
//
// A backup that appears at the destination while it is still being written is the worst artefact
// this system can produce: it has the right name, a plausible size, and it will not authenticate.
// Retention would count it as a good backup and delete a real one to make room, and an operator
// would find out on the day they needed it.
//
// So every write goes to `<name>.partial` and is RENAMED into place only once the stream has closed
// cleanly. Rename within a directory is atomic on every filesystem this runs on. A crash mid-backup
// leaves a `.partial` file, which is not a backup name, so nothing counts it and nothing deletes on
// account of it.
//
// ── Why this is an interface with one implementation ──────────────────────────────────────────
//
// B3 adds object storage. Everything above this file — the schedule, the runner, retention, the
// audit trail — is written against `BackupDestinationAdapter` and needs no change when it arrives.

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import type { BackupDestination } from './backupSchedule';

/** A backup being written. Exactly one of `commit` or `abort` must be called. */
export interface BackupSink {
  /** The stream `writeBackup` writes into. Never ended by the caller — `commit` does that. */
  out: Writable;
  /** Make the file visible under its final name. Answers its size in bytes. */
  commit(): Promise<number>;
  /** Remove whatever was written. Never throws — it runs on the failure path. */
  abort(): Promise<void>;
}

export interface BackupDestinationAdapter {
  /** One line naming where files go, for logs, the audit trail and the dashboard. */
  describe(): string;
  /**
   * Make the destination usable, or throw with a sentence an operator can act on.
   *
   * Called before every run rather than once at startup: a network mount that vanished between two
   * nightly backups must fail the run that follows it, not stay "verified" from boot.
   */
  ensure(): Promise<void>;
  begin(name: string): Promise<BackupSink>;
  /** Every entry at the destination. Filtering to our own files is the caller's job (`prunable`). */
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/** The suffix a half-written file carries. Deliberately not a backup name — see the note above. */
export const PARTIAL_SUFFIX = '.partial';

class DirectoryDestination implements BackupDestinationAdapter {
  constructor(private readonly dir: string) {}

  describe(): string {
    return this.dir;
  }

  async ensure(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (err) {
      // The operator chose this path and can fix it, but only if told which path and what went
      // wrong. "ENOENT" alone has sent people looking in the wrong place.
      throw new Error(`Could not use ${this.dir} for backups: ${(err as Error).message}`);
    }

    const info = await stat(this.dir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`${this.dir} is not a folder.`);
  }

  async begin(name: string): Promise<BackupSink> {
    const finalPath = join(this.dir, name);
    const partPath = `${finalPath}${PARTIAL_SUFFIX}`;
    const out = createWriteStream(partPath);

    // Wait for the descriptor before handing the stream back.
    //
    // `createWriteStream` opens asynchronously, so without this `begin` returns before the file
    // exists — and a destination that cannot be written to (permissions, a full disk, a mount that
    // went away) reports it later as an 'error' event on a stream nobody is listening to yet. An
    // unhandled 'error' on a stream takes the process down, which is a spectacular way to lose a
    // gateway over a backup. Awaiting here turns it into a rejection the runner already catches.
    await once(out, 'open');

    // From here the stream must have an error listener AT ALL TIMES.
    //
    // `writeBackup` attaches one only while it is waiting for drain, so anything that fails while
    // the stream is not backpressured — a full disk, a network mount going away mid-export — is an
    // 'error' event with no listener, which Node escalates to an uncaught exception. The gateway
    // then dies over a backup. `abort` hits the same thing from the other side: destroying a stream
    // with writes still in flight fires their callbacks against a destroyed stream.
    //
    // Holding the first error and re-raising it from `commit` turns both into what they always
    // should have been — a backup run that failed, and said why.
    let failure: Error | null = null;
    out.on('error', (err: Error) => { failure ??= err; });

    return {
      out,
      async commit(): Promise<number> {
        out.end();
        // `finished` resolves once the stream is CLOSED, not merely flushed — renaming a file whose
        // descriptor is still open is how a backup ends up short on some platforms. Its own
        // rejection is discarded in favour of the recorded error, which is the first one and so the
        // one that explains the rest.
        await finished(out).catch(() => { /* see `failure` */ });
        if (failure) throw failure;

        await rename(partPath, finalPath);
        return (await stat(finalPath)).size;
      },
      async abort(): Promise<void> {
        try {
          out.destroy();
          await rm(partPath, { force: true });
        } catch { /* the failure path must not raise a second failure over the first */ }
      },
    };
  }

  async list(): Promise<string[]> {
    return readdir(this.dir).catch(() => []);
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true });
  }
}

/** The adapter for a configured destination. One kind today; B3 adds branches here. */
export function destinationAdapter(d: BackupDestination): BackupDestinationAdapter {
  return new DirectoryDestination(d.path.trim());
}
