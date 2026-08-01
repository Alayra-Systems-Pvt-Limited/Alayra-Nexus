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

// Backups held in the gateway's own database (Phase B2), in both directions.
//
// ── Why the database ──────────────────────────────────────────────────────────────────────────
//
// It is the only storage that exists and survives everywhere this is deployed. A folder on the
// app's filesystem is durable on a VM and wiped on every redeploy inside a container, and nothing
// in here can tell those apart — so a destination the operator has to choose correctly is one most
// of them will get wrong, silently, until the morning they need it.
//
// ── Why chunks ────────────────────────────────────────────────────────────────────────────────
//
// B1 streams the export precisely so a large gateway never holds its own database in memory. A
// single `Bytes` column would have discarded that at the final step: the whole file would have to
// be assembled in a Buffer before the insert, and read back the same way. Rows of bounded size keep
// the stream intact going in and coming out.
//
// ── Why a half-written backup carries a different name ────────────────────────────────────────
//
// The same reason the directory destination writes `<name>.partial` and renames: a backup that
// appears in the list while it is still being written has a plausible size and will not
// authenticate, and retention would count it as real and delete a good one to make room. The parent
// row must exist before its chunks can point at it, so it is created immediately — under the
// partial name, which is not a backup name. `commit` renames it, which is the single atomic moment
// the backup becomes real. A crash leaves a partial row that nothing counts and nothing serves.

import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { prisma } from '../prisma';
import { PARTIAL_SUFFIX } from '../backupDestination';

/**
 * Bytes per chunk row.
 *
 * Large enough that a sizeable backup is thousands of rows rather than millions, small enough that
 * neither a Postgres BYTEA parameter nor a SQLite BLOB is unreasonable and only this much is ever
 * held in memory at once on either path.
 */
export const CHUNK_BYTES = 1024 * 1024;

/**
 * Chunk rows fetched per round trip when reading back.
 *
 * The read is paged rather than a single `findMany`, because a single one would materialise the
 * entire backup in memory and undo the reason the chunks exist.
 */
const READ_BATCH = 8;

export interface StoredBackup {
  id: string;
  filename: string;
  createdAt: Date;
  bytes: number;
  rows: number;
  origin: string;
}

/** A backup being written into the database. Exactly one of `commit` or `abort` must be called. */
export interface StoredBackupWriter {
  out: Writable;
  /** What the export turned out to contain. Recorded at commit; display only. */
  describeContents(summary: { rows: number }): void;
  /** Make the backup visible under its real name. Answers its size in bytes. */
  commit(): Promise<number>;
  /** Remove every trace. Never throws — it runs on the failure path. */
  abort(): Promise<void>;
}

/**
 * Begin storing a backup under `filename`.
 *
 * The returned `out` is what `writeBackup` streams into. Backpressure is honoured properly: the
 * callback passed to `_write` is not invoked until the chunk it completed has actually been
 * inserted, so a slow database slows the export rather than queueing the whole file in memory.
 */
export async function beginStoredBackup(
  filename: string,
  origin: 'scheduled' | 'manual' = 'scheduled',
): Promise<StoredBackupWriter> {
  const partialName = `${filename}${PARTIAL_SUFFIX}`;

  // Any partial left by a previous crash under the same name is cleared first. Chunks cascade with
  // it. Without this the unique constraint on `filename` would reject the new attempt, and a single
  // interrupted backup would block that name until somebody deleted the row by hand.
  await prisma.backup.deleteMany({ where: { filename: partialName } });

  const parent = await prisma.backup.create({
    data: { filename: partialName, bytes: 0, rows: 0, origin },
    select: { id: true },
  });

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let seq = 0;
  let total = 0;
  let rows = 0;
  /** The first failure, re-raised from `commit`. See the note in backupDestination.ts. */
  let failure: Error | null = null;

  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const data = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    await prisma.backupChunk.create({ data: { backupId: parent.id, seq: seq++, data } });
    total += data.length;
  };

  const out = new Writable({
    async write(piece: Buffer, _enc, done) {
      try {
        pending.push(piece);
        pendingBytes += piece.length;
        // Only whole chunks are written here; the remainder is flushed by `commit`. Writing a short
        // chunk per `write` call would produce a row per stream piece, which for a compressed export
        // is thousands of tiny rows.
        while (pendingBytes >= CHUNK_BYTES) {
          const joined = Buffer.concat(pending, pendingBytes);
          const head = joined.subarray(0, CHUNK_BYTES);
          const tail = joined.subarray(CHUNK_BYTES);
          pending = tail.length ? [tail] : [];
          pendingBytes = tail.length;
          await prisma.backupChunk.create({ data: { backupId: parent.id, seq: seq++, data: head } });
          total += head.length;
        }
        done();
      } catch (err) {
        failure ??= err as Error;
        done(err as Error);
      }
    },
  });

  // The stream must have an error listener at all times, or Node escalates an 'error' event with no
  // listener into an uncaught exception and the gateway dies over a backup.
  out.on('error', (err: Error) => { failure ??= err; });

  return {
    out,
    describeContents({ rows: n }) { rows = n; },

    async commit(): Promise<number> {
      out.end();
      // `end()` returns immediately — the `_write` callbacks it flushes are async and may still be
      // inserting. Without waiting, the remainder below could be written under a sequence number a
      // still-running write is about to claim, and the backup would reassemble in the wrong order.
      // `finished` rejects on the same error already recorded, so the recorded one wins.
      await finished(out).catch(() => { /* see `failure` */ });
      if (failure) throw failure;

      await flush();
      if (failure) throw failure;

      // The one atomic moment this becomes a real backup.
      await prisma.backup.update({
        where: { id: parent.id },
        data: { filename, bytes: total, rows },
      });
      return total;
    },

    async abort(): Promise<void> {
      try {
        out.destroy();
        // Chunks cascade, so the parent alone is enough.
        await prisma.backup.delete({ where: { id: parent.id } });
      } catch { /* the failure path must not raise a second failure over the first */ }
    },
  };
}

/**
 * Stream a stored backup back out, in `seq` order.
 *
 * Ordered explicitly and paged by the last sequence number seen rather than by `skip`, so the read
 * is stable and stays O(batch) in memory however large the backup is. This one stream serves all
 * three consumers — the download endpoint, the optional off-machine copy, and restore.
 */
export function readStoredBackup(backupId: string): Readable {
  return Readable.from(chunkStream(backupId));
}

async function* chunkStream(backupId: string): AsyncGenerator<Buffer> {
  let after = -1;

  for (;;) {
    const batch = await prisma.backupChunk.findMany({
      where: { backupId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: READ_BATCH,
      select: { seq: true, data: true },
    });
    if (batch.length === 0) return;

    for (const chunk of batch) yield Buffer.from(chunk.data);
    after = batch[batch.length - 1].seq;
  }
}

// ── Reading the list ──────────────────────────────────────────────────────────

/** Whether a name belongs to a backup that finished being written. */
export const isComplete = (filename: string): boolean => !filename.endsWith(PARTIAL_SUFFIX);

/**
 * Every completed backup, newest first.
 *
 * Partials are excluded rather than shown as "in progress": a row that exists because a backup
 * crashed three days ago is not progress, and offering it for download would hand somebody a file
 * that cannot be opened.
 */
export async function listStoredBackups(): Promise<StoredBackup[]> {
  const all = await prisma.backup.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, createdAt: true, bytes: true, rows: true, origin: true },
  });
  return all.filter((b) => isComplete(b.filename));
}

/** One backup by name, or null. Only completed ones are addressable. */
export async function findStoredBackup(filename: string): Promise<StoredBackup | null> {
  if (!isComplete(filename)) return null;
  return prisma.backup.findUnique({
    where: { filename },
    select: { id: true, filename: true, createdAt: true, bytes: true, rows: true, origin: true },
  });
}

/** Delete by name. Chunks cascade. */
export async function deleteStoredBackup(filename: string): Promise<void> {
  await prisma.backup.deleteMany({ where: { filename } });
}

/** Total bytes held, for the dashboard — backups in the database are not free. */
export async function storedBackupBytes(): Promise<number> {
  const done = await listStoredBackups();
  return done.reduce((sum, b) => sum + b.bytes, 0);
}
