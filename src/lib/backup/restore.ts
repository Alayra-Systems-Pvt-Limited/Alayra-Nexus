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
import { missingEnvNames, schemaShape, type SchemaShape } from './provenance';
import { assertRestorable, type Difference } from './schemaDrift';
import {
  findCollisions, mergeCollisions, MODELS_WITH_UNIQUE_COLUMNS,
  type Collision, type CollisionClient,
} from './collisions';
import { CIPHER, TAG_BYTES, parseHeader, unwrapFileKey, passphraseProblem } from './format';

/** Rows held before being written. Bounded so a large table never becomes a large heap. */
const WRITE_BATCH = 500;

/** Rows held before their unique values are checked against what is already here. */
const CHECK_BATCH = 500;

/**
 * How long to wait for a connection from the pool before giving up — NOT how long the restore may
 * take (A3).
 *
 * These were the same value, which was harmless while the transaction budget was two minutes and a
 * bug the moment it became thirty: a gateway whose pool was momentarily busy would sit waiting half
 * an hour before starting work, with nothing to show for it. They are unrelated quantities. Prisma's
 * own default here is 2s; ten is patient enough for a restore to survive a burst of dashboard
 * traffic, and short enough that "the pool is exhausted" is still reported as a failure.
 */
const POOL_WAIT_MS = 10_000;

/** Prisma's code for a transaction that ran past its budget. */
const TRANSACTION_EXPIRED = 'P2028';

/** Conservative fallback for library callers (the parity suite). The gateway passes its own. */
export const DEFAULT_RESTORE_TIMEOUT_MS = 120_000;

export type RestoreMode = 'merge' | 'replace';

export interface RestoreOptions {
  client: PrismaClient;
  engine: DbEngine;
  /**
   * Omit only when the file carries a gateway recipient and this is the gateway that wrote it —
   * the unattended path. A person restoring a file types the passphrase.
   */
  passphrase?: string;
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
  /**
   * Called with the running total as each batch lands, so a caller can report progress (A4).
   *
   * Deliberately synchronous and deliberately ignored if it throws: this runs inside the write
   * transaction, and a progress report that could fail a restore would be a reporting feature that
   * destroys the thing it reports on. Callers wanting to do I/O here fire and forget.
   */
  onProgress?: (rowsWritten: number) => void;
}

export interface RestorePlan {
  /** What wrote the file. */
  gatewayVersion: string;
  createdAt: string;
  sourceEngine: string;
  rowsInFile: Record<string, number>;
  totalRowsInFile: number;
  secretsInFile: number;
  /**
   * The source's column map, when the file carries one (C1).
   *
   * Null for anything written before C1 — reported rather than refused. A backup that predates the
   * check is not a backup that failed it, and refusing every older file would be a data-loss policy
   * dressed as caution. Acting on this is C4's job; this only surfaces it.
   */
  sourceSchema: SchemaShape | null;
  /**
   * Settings the source gateway had configured that this one does not (C5), by name.
   *
   * Empty when the file predates C5 or when nothing is missing. This is the difference between a
   * restore that worked and one that looked like it did: the data arrives, and single sign-on is
   * quietly dead because SSO_CLIENT_ID lives in an environment that did not come with it.
   */
  missingEnv: string[];
  /**
   * Differences between the file's schema and this gateway's that do NOT prevent the restore (C4).
   *
   * Blocking differences never reach here — those throw. What is left is the additive drift a
   * restore absorbs: columns added since, which take their defaults, and models that will be left
   * empty. Worth showing, not worth stopping for.
   */
  schemaDrift: Difference[];
}

export interface RestoreResult extends RestorePlan {
  mode: RestoreMode;
  dryRun: boolean;
  /** Rows actually inserted, per model. Under `merge` this is legitimately lower. */
  written: Record<string, number>;
  totalWritten: number;
  /**
   * Rows the file held that this gateway did not insert, per model.
   *
   * Under `merge` this is expected and usually means the row was already here. Under `replace` it
   * must be zero, and the restore refuses if it is not — see `assertNothingDropped`.
   *
   * Always zero for a dry run, which writes nothing by design; `collisions` is a dry run's answer.
   */
  skipped: Record<string, number>;
  totalSkipped: number;
  /**
   * Rows whose unique value already belongs to a DIFFERENT row on this gateway, and which a merge
   * would therefore drop without saying so. Populated by a `merge` dry run only — see collisions.ts
   * for why this cannot be answered during the restore itself.
   */
  collisions: Collision[];
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
async function* decryptedLines(input: Readable, passphrase?: string): AsyncGenerator<string> {
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
      // Recover the file key from whichever recipient we can satisfy, then decrypt the body with it.
      const fileKey = await unwrapFileKey(header, { passphrase });
      decipher = createDecipheriv(CIPHER, fileKey, Buffer.from(header.cipher.iv, 'hex'));
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

/**
 * Read structurally, and only for what is needed — which is what makes the format additive.
 *
 * A manifest written by a NEWER gateway carries fields this does not name, and they are ignored
 * rather than refused, so a v1.4 backup still opens on a v1.3 gateway (without the checks v1.4
 * added, which is the honest degradation). It is also why C1 and C5 did not need a version bump:
 * nothing here breaks when the manifest grows.
 */
interface Manifest {
  kind: string; createdAt?: string; gatewayVersion?: string; engine?: string;
  schema?: SchemaShape;
  env?: string[];
}
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
  // Validated only when one was supplied: the unattended path opens the file with the gateway's own
  // key and has no passphrase to check. `unwrapFileKey` is what refuses when neither works.
  if (opts.passphrase !== undefined) {
    const problem = passphraseProblem(opts.passphrase);
    if (problem) throw new Error(problem);
  }

  const rowsInFile = zeroed();
  const written = zeroed();
  const collisions: Collision[] = [];

  let manifest: Manifest | null = null;
  let trailer: Trailer | null = null;
  let totalRowsInFile = 0;
  let secretsInFile = 0;
  let secretsRekeyed = 0;
  let tablesCleared = 0;

  const lines = decryptedLines(opts.input, opts.passphrase);

  // ── The manifest, pulled BEFORE anything else happens (C4) ─────────────────────────────────
  //
  // Deliberately consumed on its own rather than inside the loop below, and the reason is the
  // ordering: `replace` empties every table as the first act inside its transaction, so a schema
  // check that ran when the manifest came round in the loop would run AFTER the truncate. The
  // transaction would still roll it back — nothing would be lost — but the gateway would have taken
  // ACCESS EXCLUSIVE on every table, entered maintenance mode and refused live traffic, all to
  // reach a conclusion it could have drawn from the first line of the file.
  //
  // Async generators resume where they were left, so the loops below continue from line two.
  const first = await lines.next();
  if (first.done) throw new Error('This backup file is empty.');
  const firstRow = decodeRow(first.value);
  if (firstRow.kind !== 'manifest') {
    throw new Error('This backup file has no manifest — it may not be an Alayra Nexus backup.');
  }
  manifest = firstRow as unknown as Manifest;

  // Throws, changing nothing, when the schema has moved too far. Returns the non-blocking
  // differences so the plan can mention them — a column that will take its default is worth
  // knowing about and is not a reason to refuse.
  const schemaDrift = assertRestorable(
    manifest.schema ?? null, schemaShape(), manifest.gatewayVersion ?? 'an unknown version',
  );

  // ── Dry run: read everything, prove it opens, write nothing ────────────────────────────────
  if (opts.dryRun) {
    // `replace` empties every table before inserting, so nothing it writes can collide with
    // anything. Only `merge` lands rows alongside data that is already here, and only merge can
    // therefore lose a row to a unique constraint it did not expect.
    const checking = opts.mode === 'merge';
    let batch: Pending | null = null;

    const check = async (): Promise<void> => {
      if (!batch || batch.rows.length === 0) return;
      mergeCollisions(collisions, await findCollisions(opts.client as unknown as CollisionClient, batch.model, batch.rows));
      batch.rows = [];
    };

    for await (const line of lines) {
      const row = decodeRow(line);
      if (row.kind === 'manifest') { manifest = row as unknown as Manifest; continue; }
      if (row.kind === 'trailer') { trailer = row as unknown as Trailer; continue; }
      const model = String(row.model);
      if (!(model in rowsInFile)) throw new Error(`This backup contains a table this gateway does not know: "${model}".`);
      rowsInFile[model]++;
      totalRowsInFile++;
      secretsInFile += countSecrets(model, row);

      // Nine of the sixteen models have no unique column but their primary key, tokenUsage — the
      // largest by far — among them. Skipping those is what keeps a dry run's cost proportional to
      // the part of the schema that can actually collide.
      if (!checking || !MODELS_WITH_UNIQUE_COLUMNS.has(model)) continue;
      if (batch && batch.model !== model) await check();
      if (!batch || batch.model !== model) batch = { model, rows: [] };
      batch.rows.push(row);
      if (batch.rows.length >= CHECK_BATCH) await check();
    }
    await check();

    assertComplete(manifest, trailer, rowsInFile, totalRowsInFile);
    return {
      ...plan(manifest, rowsInFile, totalRowsInFile, secretsInFile, schemaDrift),
      mode: opts.mode, dryRun: true,
      written, totalWritten: 0,
      // Not `rowsInFile - written`: a dry run writes nothing on purpose, so reporting every row as
      // "skipped" would describe the dry run rather than what a real restore would do.
      skipped: zeroed(), totalSkipped: 0,
      collisions,
      secretsRekeyed: 0, tablesCleared: 0,
    };
  }

  // ── The real thing, entirely inside one transaction ────────────────────────────────────────
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS;

  // The deadline this code enforces itself, because Prisma's is no longer dependable on both
  // engines.
  //
  // `$transaction(..., { timeout })` is still honoured by the PostgreSQL driver adapter — it raises
  // P2028, caught below. The SQLite adapter does NOT honour it: measured on Prisma 7.9.1, a
  // transaction running 411ms resolved successfully under `timeout: 1`. Nothing warns; the option is
  // simply not applied.
  //
  // That is the entire restore-timeout guarantee gone on standalone, the mode where it matters most,
  // because a standalone gateway is the one with no operator watching a dashboard. Leaving it to
  // Prisma would mean the feature works on one engine and silently does not on the other.
  //
  // Checked here instead, on the wall clock, in the loop that does the work. Throwing from inside
  // the transaction rolls it back exactly as an expired transaction would, so "changes nothing"
  // still holds — and it now holds for the same reason on both engines rather than by delegation.
  const deadline = Date.now() + timeoutMs;

  try {
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

      if (opts.onProgress) {
        // Swallowed on purpose — see onProgress. A restore must not fail because something that
        // was only watching it did.
        try { opts.onProgress(Object.values(written).reduce((a, b) => a + b, 0)); } catch { /* watcher */ }
      }
    };

    for await (const line of lines) {
      const row = decodeRow(line);
      if (row.kind === 'manifest') { manifest = row as unknown as Manifest; continue; }
      if (row.kind === 'trailer') { trailer = row as unknown as Trailer; continue; }

      // Per row rather than per batch: a batch holds up to a thousand rows, and a budget that can
      // only be noticed a thousand rows late is not a budget on a restore that is already too slow.
      if (Date.now() > deadline) throw new RestoreTimeoutError(timeoutMs);

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
    if (opts.mode === 'replace') assertNothingDropped(rowsInFile, written);
    }, {
      timeout: timeoutMs,
      // Deliberately NOT timeoutMs — see POOL_WAIT_MS. Waiting for a free connection and doing the
      // work are different things, and coupling them made the gateway wait half an hour to start.
      maxWait: POOL_WAIT_MS,
    });
  } catch (e) {
    // A restore that ran out of budget is not a damaged file, and must not be reported as one. The
    // caller needs to be able to tell "this needs longer" from "this cannot be restored at all".
    //
    // Two ways to arrive here now: our own deadline threw from inside the transaction, or Postgres
    // expired it first. The first is already the right error and must pass through unchanged —
    // wrapping it again would lose the budget it was told.
    if (e instanceof RestoreTimeoutError) throw e;
    if (isTransactionExpired(e)) throw new RestoreTimeoutError(timeoutMs);
    throw e;
  }

  const skipped = zeroed();
  for (const m of MODEL_ORDER) skipped[m] = rowsInFile[m] - written[m];

  return {
    ...plan(manifest, rowsInFile, totalRowsInFile, secretsInFile, schemaDrift),
    mode: opts.mode, dryRun: false,
    written,
    totalWritten: Object.values(written).reduce((a, b) => a + b, 0),
    skipped,
    totalSkipped: Object.values(skipped).reduce((a, b) => a + b, 0),
    // A real restore cannot answer this: by the time a row is skipped the transaction is open and
    // "stop and look at this" is no longer on offer. `totalSkipped` is the signal here, and a dry
    // run is what turns that number into which rows and why.
    collisions: [],
    secretsRekeyed, tablesCleared,
  };
}

/**
 * The restore ran past its budget — distinct from every other failure, because the file is fine.
 *
 * Everything else `readBackup` throws means "this backup cannot be restored". This one means "this
 * backup needs longer", which is a different sentence to show an operator and a different HTTP
 * status to answer with.
 */
export class RestoreTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `The restore ran longer than the ${Math.round(timeoutMs / 1000)}s limit and was rolled back — ` +
      'nothing was changed. Raise NEXUS_RESTORE_TIMEOUT_MS and try again; a large backup is ' +
      'legitimately slow, not broken.');
    this.name = 'RestoreTimeoutError';
  }
}

/**
 * P2028 is Prisma's expired-transaction code.
 *
 * Checked STRUCTURALLY rather than with `instanceof PrismaClientKnownRequestError`, for the reason
 * bulkInsert.ts documents at length: there are two generated clients here, each carrying its own
 * copy of the Prisma runtime and therefore its own error classes, so an error raised by the SQLite
 * client is not an `instanceof` the class exported by `@prisma/client`. That mistake was made once
 * already and cost a silent failure on one engine only.
 */
function isTransactionExpired(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === TRANSACTION_EXPIRED;
}

/**
 * On `replace`, every row in the file must land — so refuse if any did not.
 *
 * The tables were emptied moments earlier inside this same transaction, which means there is
 * nothing left for a row to collide WITH. A shortfall is therefore not a duplicate being tolerated;
 * it is rows disappearing, and the only honest response is to roll the whole thing back.
 *
 * This is the guard that would have caught the defect collisions.ts documents, had it been on the
 * destructive path: `skipDuplicates` returning a smaller count than it was handed, and every layer
 * above it reporting success.
 *
 * Exported only so it can be tested. The condition it guards against cannot be produced through
 * `readBackup` — that is the point of it — so the alternative is a safety check that has never once
 * been observed to fire, which is indistinguishable from one that does not work.
 */
export function assertNothingDropped(rowsInFile: Record<string, number>, written: Record<string, number>): void {
  const lost = MODEL_ORDER
    .filter((m) => written[m] < rowsInFile[m])
    .map((m) => `${m} (${rowsInFile[m] - written[m]} of ${rowsInFile[m]} missing)`);
  if (lost.length === 0) return;

  throw new Error(
    `Restore did not write every row it read: ${lost.join(', ')}. ` +
    'Every table was emptied first, so nothing should have been skipped. Nothing has been changed.');
}

/** A per-model counter starting at zero, so every model appears in the report even at zero rows. */
function zeroed(): Record<string, number> {
  return Object.fromEntries(MODEL_ORDER.map((m) => [m, 0]));
}

function plan(
  manifest: Manifest | null, rowsInFile: Record<string, number>, totalRowsInFile: number, secretsInFile: number,
  schemaDrift: Difference[],
): RestorePlan {
  return {
    gatewayVersion: manifest?.gatewayVersion ?? 'unknown',
    createdAt: manifest?.createdAt ?? 'unknown',
    sourceEngine: manifest?.engine ?? 'unknown',
    rowsInFile, totalRowsInFile, secretsInFile,
    sourceSchema: manifest?.schema ?? null,
    missingEnv: missingEnvNames(manifest?.env),
    schemaDrift,
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
