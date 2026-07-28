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

// Writing the backup (Phase B1.1).
//
// Reads every table through Prisma and writes one encrypted document. Logical, not physical: rows
// via the ORM rather than `pg_dump` or a file copy, because the whole point is that a backup taken
// from a SQLite gateway restores onto PostgreSQL and the other way round. A physical dump is welded
// to the engine that produced it, and would make the migration path (S3) impossible.
//
// ── It streams, and it has to ─────────────────────────────────────────────────────────────────
//
// TokenUsage is unbounded — it grows with every request the gateway ever proxies. Building the
// document in memory would work in every test and fail on the one deployment large enough to matter,
// which is the deployment whose backup matters most. So rows are read a page at a time by cursor,
// encrypted through a stream, and written out; peak memory is one page, not one database.
//
// ── Secrets come out from under the master key ────────────────────────────────────────────────
//
// Every secret is decrypted on the way into the file and re-encrypted with the RECEIVING gateway's
// key on restore (see secrets.ts). That is what makes a backup portable rather than merely
// restorable onto the machine that wrote it. The plaintext exists only inside the cipher stream —
// it is never written anywhere, and the file on disk is ciphertext from the first byte after the
// header.

import { createCipheriv } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { decrypt } from '../encryption';
import type { DbEngine } from '../mode';
import { MODEL_ORDER } from './modelOrder';
import { schemaShape, configuredEnvNames, type SchemaShape } from './provenance';
import { rekeyRow, countSecrets } from './secrets';
import { encodeRow } from './rowCodec';
import {
  CIPHER, BACKUP_FORMAT, BACKUP_VERSION,
  newFileKey, wrapForPassphrase, wrapForGateway, buildHeader, headerBytes, passphraseProblem,
  type Recipient,
} from './format';

/** How many rows are read from one table at a time. */
const DEFAULT_PAGE = 500;

export interface ExportOptions {
  client: PrismaClient;
  engine: DbEngine;
  /** The operator's backup passphrase. Losing it means losing the backup. */
  passphrase: string;
  /** Where the file goes — a file stream, or an HTTP response. */
  out: Writable;
  /** Recorded in the manifest so a restore can say what wrote the file. */
  gatewayVersion: string;
  pageSize?: number;
  /**
   * Also let THIS gateway open the file without the passphrase.
   *
   * Default false, and the default differs by path on purpose. A scheduled backup stays on the
   * operator's own infrastructure and must run unattended, so it wants this. A manual download
   * leaves the building, and a second way in only helps someone who already has the .env.
   */
  includeGatewayRecipient?: boolean;
  /**
   * Overrides for what the manifest records about the source (C1, C5).
   *
   * Both default to reading this process. They exist because the format fixture is generated from a
   * fake client and must stay byte-reproducible — a fixture carrying whichever environment
   * variables happened to be set on the machine that built it would open on one machine and fail on
   * another, which is a test that fails for a reason unrelated to the format.
   */
  schema?: SchemaShape;
  env?: string[];
}

export interface ExportSummary {
  rowsByModel: Record<string, number>;
  totalRows: number;
  /** Secrets actually decrypted into the file — counted, never assumed. */
  secrets: number;
}

/** The first line inside the encrypted payload. Everything describing the deployment lives here. */
interface Manifest {
  kind: 'manifest';
  format: string;
  version: number;
  createdAt: string;
  gatewayVersion: string;
  /** The engine that WROTE it. Informational — a backup restores onto either. */
  engine: DbEngine;
  models: readonly string[];
  /**
   * The source gateway's column map (C1). What makes a backup checkable against a schema that has
   * moved on, instead of failing partway through with a Prisma error naming one column.
   */
  schema: SchemaShape;
  /**
   * Which of the gateway's own settings were configured, BY NAME ONLY (C5). Never values — this
   * file leaves the building. Lets a restore warn that the source had SSO and this gateway does not.
   */
  env: string[];
}

/** The last line. Its presence is what proves the export ran to completion. */
interface Trailer {
  kind: 'trailer';
  rowsByModel: Record<string, number>;
  totalRows: number;
  secrets: number;
}

/** A Prisma delegate, reduced to the two calls this module makes. */
interface Delegate {
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
}

/**
 * Write to a stream, waiting when it asks us to.
 *
 * Ignoring the `false` from `write()` is how an export of a large table becomes an out-of-memory
 * crash: Node buffers everything the destination has not accepted yet, so a slow disk or a slow
 * HTTP client would be absorbed entirely into this process's heap.
 */
function write(stream: Writable, chunk: string | Buffer): Promise<void> {
  return stream.write(chunk) ? Promise.resolve() : new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

/**
 * Export the whole gateway to `out`, encrypted.
 *
 * Returns what was actually written, counted as it went — so a caller reporting "412 rows, 9 secrets"
 * is repeating an observation rather than an intention.
 */
export async function writeBackup(opts: ExportOptions): Promise<ExportSummary> {
  const problem = passphraseProblem(opts.passphrase);
  if (problem) throw new Error(problem);

  const pageSize = opts.pageSize ?? DEFAULT_PAGE;

  // One random key encrypts the body; it is then wrapped for each way the file may be opened. The
  // passphrase recipient is not optional — buildHeader refuses a set without one.
  const fileKey = newFileKey();
  const recipients: Recipient[] = [await wrapForPassphrase(fileKey, opts.passphrase)];
  if (opts.includeGatewayRecipient) recipients.push(wrapForGateway(fileKey));

  const header = buildHeader(recipients);
  const aad = headerBytes(header);

  // The header goes out in the clear — it holds the salt and parameters needed to derive the key,
  // so it cannot itself be encrypted — and is bound into the ciphertext as AAD, so editing it
  // breaks authentication rather than silently changing how the file is read.
  await write(opts.out, aad);
  await write(opts.out, '\n');

  const cipher = createCipheriv(CIPHER, fileKey, Buffer.from(header.cipher.iv, 'hex'));
  cipher.setAAD(aad);

  // `end: false` so finishing the cipher does not close the destination: the authentication tag
  // still has to be appended after it.
  cipher.pipe(opts.out, { end: false });

  const manifest: Manifest = {
    kind: 'manifest',
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    gatewayVersion: opts.gatewayVersion,
    engine: opts.engine,
    models: MODEL_ORDER,
    schema: opts.schema ?? schemaShape(),
    env: opts.env ?? configuredEnvNames(),
  };
  await write(cipher, `${JSON.stringify(manifest)}\n`);

  const rowsByModel: Record<string, number> = {};
  let totalRows = 0;
  let secrets = 0;

  for (const model of MODEL_ORDER) {
    const delegate = (opts.client as unknown as Record<string, Delegate>)[model];
    if (!delegate?.findMany) {
      throw new Error(`The Prisma client has no "${model}" model. The backup write order is out of step with the schema.`);
    }

    let count = 0;
    let cursor: string | undefined;

    // Cursor paging, not skip/take: an offset makes the database re-scan everything it has already
    // handed over, so the cost of the last page of a large table grows with the table.
    for (;;) {
      const page = await delegate.findMany({
        take: pageSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;

      for (const row of page) {
        secrets += countSecrets(model, row);
        // decrypt here: the secret leaves the master key's protection and enters the file's.
        await write(cipher, `${encodeRow({ model, ...rekeyRow(model, row, decrypt) })}\n`);
        count++;
      }

      cursor = page[page.length - 1].id as string;
      if (page.length < pageSize) break;
    }

    rowsByModel[model] = count;
    totalRows += count;
  }

  const trailer: Trailer = { kind: 'trailer', rowsByModel, totalRows, secrets };
  await write(cipher, `${JSON.stringify(trailer)}\n`);

  // Finish the cipher, wait for the last bytes to reach `out`, then append the tag. The tag only
  // exists after final(), which is why it cannot simply be part of the stream.
  await new Promise<void>((resolve, reject) => {
    cipher.once('end', resolve);
    cipher.once('error', reject);
    opts.out.once('error', reject);
    cipher.end();
  });
  await write(opts.out, cipher.getAuthTag());

  return { rowsByModel, totalRows, secrets };
}
