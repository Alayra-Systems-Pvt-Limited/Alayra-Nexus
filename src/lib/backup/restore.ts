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

// Reading the backup back (Phase B1.2).
//
// ── Why every write is inside one transaction ─────────────────────────────────────────────────
//
// Not tidiness — it is forced by the cryptography. GCM cannot tell you a file is authentic until the
// LAST byte has been read, because the tag covers the whole ciphertext. So a restore is committed to
// reading, and writing, before it can know the file was not truncated or tampered with. The only way
// that is safe is if nothing is durable until the end: rows go in as they are parsed, `final()` is
// called, and the transaction commits only if authentication passed. A failure anywhere — a bad tag,
// a short file, a constraint violation on row 90,000 — leaves the gateway exactly as it was.
//
// A restore that half-succeeded would be the worst outcome this feature could produce: an operator
// believing they had recovered, on a gateway holding an arbitrary prefix of their data.
//
// ── Secrets are re-keyed, which is what makes a backup portable ───────────────────────────────
//
// The file holds plaintext secrets (inside the encryption, never on disk). Each one is re-encrypted
// with THIS gateway's master key on the way in, so a backup taken from one machine genuinely works
// on another. Copying the ciphertext across would produce a restore that reports success and leaves
// every provider key undecryptable — see secrets.ts.
//
// ── Merge vs replace ──────────────────────────────────────────────────────────────────────────
//
// `replace` empties every table first: the gateway becomes the backup. `merge` inserts only what is
// missing, matched on primary key, and is the safe default for pulling one gateway's data into
// another. Neither UPDATES an existing row — a restore that silently overwrote current data with
// older data would be indistinguishable from corruption.

import { createDecipheriv, type DecipherGCM } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { encrypt } from '../encryption';
import type { DbEngine } from '../mode';
import { emptyEveryTableIn, type RawExecutor } from '../resetTables';
import { createManyIgnoringDuplicates, type BulkDelegate } from '../bulkInsert';
import { MODEL_ORDER } from './modelOrder';
import { rekeyRow, countSecrets } from './secrets';
import { decodeRow } from './rowCodec';
import { CIPHER, TAG_BYTES, parseHeader, deriveKey, passphraseProblem } from './format';

/** Rows held before being written. Bounded so a large table never becomes a large heap. */
const WRITE_BATCH = 500;

export type RestoreMode = 'merge' | 'replace';

export interface RestoreOptions {
  client: PrismaClient;
  engine: DbEngine;
  passphrase: string;
  input: Readable;
  mode: RestoreMode;
  /**
   * Read, authenticate and count the whole file, then write NOTHING.
   *
   * The operator sees exactly what would happen — including that the passphrase is right and the
   * file is intact — before anything is touched. Anything destructive should be answerable in
   * advance, and `replace` is very destructive.
   */
  dryRun?: boolean;
  /** How long the write transaction may take. A large restore is legitimately slow. */
  timeoutMs?: number;
}

export interface RestorePlan {
  /** What wrote the file. */
  gatewayVersion: string;
  createdAt: string;
  sourceEngine: string;
  rowsInFile: Record<string, number>;
  totalRowsInFile: number;
  secretsInFile: number;
}

export interface RestoreResult extends RestorePlan {
  mode: RestoreMode;
  dryRun: boolean;
  /** Rows actually inserted, per model. Under `merge` this is legitimately lower. */
  written: Record<string, number>;
  totalWritten: number;
  /** Secrets re-encrypted with this gateway's key — counted, not assumed. */
  secretsRekeyed: number;
  /** Tables emptied, when the mode was `replace`. */
  tablesCleared: number;
}

/**
 * Split a byte stream into the plaintext header line and everything after it.
 *
 * The header is read a chunk at a time rather than by buffering the file: the point of streaming is
 * that a backup larger than memory can still be restored.
 */
async function* decryptedLines(input: Readable, passphrase: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  let headerLine: string | null = null;
  // DecipherGCM, not the base Decipher: `createDecipheriv` is overloaded on the algorithm, and
  // annotating with ReturnType collapses it to the overload that has neither setAAD nor setAuthTag.
  let decipher: DecipherGCM | null = null;
  let carry = '';

  /** The last TAG_BYTES of the file are the tag, and cannot be fed to update(). */
  let held = Buffer.alloc(0);

  const emit = function* (chunk: Buffer): Generator<string> {
    carry += chunk.toString('utf8');
    const parts = carry.split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) if (line) yield line;
  };

  for await (const chunk of input) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);

    if (headerLine === null) {
      pending = Buffer.concat([pending, buf]);
      const nl = pending.indexOf(0x0a);
      if (nl === -1) {
        if (pending.length > 64 * 1024) throw new Error('This does not look like an Alayra Nexus backup file.');
        continue;
      }
      headerLine = pending.subarray(0, nl).toString('utf8');
      const header = parseHeader(headerLine);
      decipher = createDecipheriv(CIPHER, await deriveKey(passphrase, header), Buffer.from(header.cipher.iv, 'hex'));
      // The header is authenticated, so a rewritten one fails here rather than changing how the
      // file is read.
      decipher.setAAD(Buffer.from(headerLine, 'utf8'));
      buf = pending.subarray(nl + 1);
      pending = Buffer.alloc(0);
    }

    // Always keep the last TAG_BYTES back: until the stream ends, they might be the tag.
    const combined = Buffer.concat([held, buf]);
    if (combined.length > TAG_BYTES) {
      const feed = combined.subarray(0, combined.length - TAG_BYTES);
      held = combined.subarray(combined.length - TAG_BYTES);
      yield* emit(decipher!.update(feed));
    } else {
      held = combined;
    }
  }

  if (headerLine === null || !decipher) throw new Error('This backup file is empty.');
  if (held.length !== TAG_BYTES) throw new Error('This backup file is truncated — its authentication tag is missing.');

  decipher.setAuthTag(held);
  // Throws when the passphrase is wrong, the file was altered, or bytes are missing. This is the
  // ONLY verification needed: GCM authenticates, so there is nothing extra to check.
  yield* emit(decipher.final());
  if (carry.trim()) yield carry;
}

interface Manifest { kind: string; createdAt?: string; gatewayVersion?: string; engine?: string }
interface Trailer { kind: string; rowsByModel?: Record<string, number>; totalRows?: number; secrets?: number }

/** A batch waiting to be written, and the model it belongs to. */
interface Pending { model: string; rows: Record<string, unknown>[] }

/**
 * Restore a backup onto this gateway.
 *
 * Throws — leaving the database untouched — when the passphrase is wrong, the file is damaged or
 * incomplete, or any row cannot be written.
 */
export async function readBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const problem = passphraseProblem(opts.passphrase);
  if (problem) throw new Error(problem);

  const rowsInFile: Record<string, number> = {};
  const written: Record<string, number> = {};
  for (const m of MODEL_ORDER) { rowsInFile[m] = 0; written[m] = 0; }

  let manifest: Manifest | null = null;
  let trailer: Trailer | null = null;
  let totalRowsInFile = 0;
  let secretsInFile = 0;
  let secretsRekeyed = 0;
  let tablesCleared = 0;

  const lines = decryptedLines(opts.input, opts.passphrase);

  // ── Dry run: read everything, prove it opens, write nothing ────────────────────────────────
  if (opts.dryRun) {
    for await (const line of lines) {
      const row = decodeRow(line);
      if (row.kind === 'manifest') { manifest = row as unknown as Manifest; continue; }
      if (row.kind === 'trailer') { trailer = row as unknown as Trailer; continue; }
      const model = String(row.model);
      if (!(model in rowsInFile)) throw new Error(`This backup contains a table this gateway does not know: "${model}".`);
      rowsInFile[model]++;
      totalRowsInFile++;
      secretsInFile += countSecrets(model, row);
    }
    assertComplete(manifest, trailer, rowsInFile, totalRowsInFile);
    return {
      ...plan(manifest, rowsInFile, totalRowsInFile, secretsInFile),
      mode: opts.mode, dryRun: true,
      written, totalWritten: 0, secretsRekeyed: 0, tablesCleared: 0,
    };
  }

  // ── The real thing, entirely inside one transaction ────────────────────────────────────────
  await opts.client.$transaction(async (tx) => {
    if (opts.mode === 'replace') {
      tablesCleared = await emptyEveryTableIn(tx as unknown as RawExecutor, opts.engine);
    }

    let batch: Pending | null = null;

    const flush = async (): Promise<void> => {
      if (!batch || batch.rows.length === 0) return;
      const delegate = (tx as unknown as Record<string, BulkDelegate<Record<string, unknown>>>)[batch.model];
      if (!delegate?.createMany) throw new Error(`This gateway has no "${batch.model}" table.`);
      // Duplicates are tolerated rather than overwritten: `merge` must not replace current data
      // with older data, and on `replace` the tables are already empty so none can occur.
      written[batch.model] += await createManyIgnoringDuplicates(delegate, batch.rows, opts.engine);
      batch.rows = [];
    };

    for await (const line of lines) {
      const row = decodeRow(line);
      if (row.kind === 'manifest') { manifest = row as unknown as Manifest; continue; }
      if (row.kind === 'trailer') { trailer = row as unknown as Trailer; continue; }

      const model = String(row.model);
      if (!(model in rowsInFile)) throw new Error(`This backup contains a table this gateway does not know: "${model}".`);
      delete row.model;

      rowsInFile[model]++;
      totalRowsInFile++;

      // Counted once. `secretsRekeyed` and `secretsInFile` are the same quantity on this path — a
      // secret present in the file is a secret re-sealed — and counting it twice would only invite
      // the two to drift apart and start disagreeing in the report.
      const n = countSecrets(model, row);
      secretsInFile += n;

      // Re-seal with THIS gateway's key. The reason a backup is portable at all.
      const sealed = rekeyRow(model, row, encrypt);
      secretsRekeyed += n;

      // The file is written in MODEL_ORDER, so a change of model means the previous one is finished.
      if (batch && batch.model !== model) await flush();
      if (!batch || batch.model !== model) batch = { model, rows: [] };
      batch.rows.push(sealed);
      if (batch.rows.length >= WRITE_BATCH) await flush();
    }

    await flush();

    // Checked INSIDE the transaction, so a file that turns out to be incomplete rolls back
    // everything already written rather than leaving a partial gateway behind.
    assertComplete(manifest, trailer, rowsInFile, totalRowsInFile);
  }, { timeout: opts.timeoutMs ?? 120_000, maxWait: opts.timeoutMs ?? 120_000 });

  return {
    ...plan(manifest, rowsInFile, totalRowsInFile, secretsInFile),
    mode: opts.mode, dryRun: false,
    written,
    totalWritten: Object.values(written).reduce((a, b) => a + b, 0),
    secretsRekeyed, tablesCleared,
  };
}

function plan(
  manifest: Manifest | null, rowsInFile: Record<string, number>, totalRowsInFile: number, secretsInFile: number,
): RestorePlan {
  return {
    gatewayVersion: manifest?.gatewayVersion ?? 'unknown',
    createdAt: manifest?.createdAt ?? 'unknown',
    sourceEngine: manifest?.engine ?? 'unknown',
    rowsInFile, totalRowsInFile, secretsInFile,
  };
}

/**
 * The file must declare itself finished, and its own count must match what was read.
 *
 * GCM already proves the bytes are intact, so this is not about tampering — it catches OUR bugs. A
 * paging fault in the writer, or a parsing fault here, would produce a file that authenticates
 * perfectly and is quietly missing rows. The trailer is the writer's own count, so a disagreement
 * means one of the two is wrong and neither should be trusted.
 */
function assertComplete(
  manifest: Manifest | null, trailer: Trailer | null,
  rowsInFile: Record<string, number>, totalRowsInFile: number,
): void {
  if (!manifest || manifest.kind !== 'manifest') {
    throw new Error('This backup file has no manifest — it may not be an Alayra Nexus backup.');
  }
  if (!trailer || trailer.kind !== 'trailer') {
    throw new Error('This backup file is incomplete: it has no trailer, so the export that wrote it did not finish.');
  }
  if (typeof trailer.totalRows === 'number' && trailer.totalRows !== totalRowsInFile) {
    throw new Error(
      `This backup file says it holds ${trailer.totalRows} rows but ${totalRowsInFile} were read. ` +
      'Refusing to restore from a file that disagrees with itself.');
  }
  for (const [model, count] of Object.entries(trailer.rowsByModel ?? {})) {
    if (rowsInFile[model] !== count) {
      throw new Error(
        `This backup file says it holds ${count} ${model} rows but ${rowsInFile[model] ?? 0} were read.`);
    }
  }
}
