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

// ── Columns a standalone database gained after it was created ─────────────────────────────────
//
// A standalone gateway builds its SQLite file once, from the committed DDL, and never upgrades it
// (see sqliteBootstrap.ts). That held while no release added a column to a table a running gateway
// already had. 1.8.0 adds six to TokenUsage and one to NexusProvider, and a file created by an older
// version would fail every usage write that carried one ("no such column"), every routing read, the
// usage-by-day read and every backup: the generated client names each column of the model, whether
// or not the file has it.
//
// So this adds exactly the columns listed below, and only to a table that exists and lacks them.
// It is deliberately not a migration system: every entry is a NULLABLE column with no default, the
// one kind of change SQLite applies without touching a row, and a row written before reads as NULL
// ("not reported"), which is the truth. A change of any other shape still needs a real upgrade
// path. A test holds this list to the committed DDL, so an entry cannot name a column the schema
// does not have, or give it a different type.

import type { PrismaClient } from '@prisma/client';

export interface AddedColumn {
  table:  string;
  column: string;
  type:   'INTEGER' | 'TEXT';
}

/** Nullable columns added to an existing table since standalone mode shipped, oldest first. */
export const ADDED_COLUMNS: readonly AddedColumn[] = [
  // 1.8.0: the token kinds a provider reports beyond input and output (lib/usageDetail.ts).
  { table: 'TokenUsage', column: 'cachedInputTokens',  type: 'INTEGER' },
  { table: 'TokenUsage', column: 'cacheWriteTokens',   type: 'INTEGER' },
  { table: 'TokenUsage', column: 'cacheWrite5mTokens', type: 'INTEGER' },
  { table: 'TokenUsage', column: 'cacheWrite1hTokens', type: 'INTEGER' },
  { table: 'TokenUsage', column: 'cacheMissTokens',    type: 'INTEGER' },
  { table: 'TokenUsage', column: 'reasoningTokens',    type: 'INTEGER' },
  // 1.8.0: a pool's Anthropic Messages settings (services/proxy/anthropicPolicy.ts).
  { table: 'NexusProvider', column: 'nativeMessages',  type: 'TEXT' },
];

/** SQL identifiers here come from the constant above, never from input; quoting is for the casing. */
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The listed columns that an existing table lacks, in list order. */
export async function missingColumns(
  client: Pick<PrismaClient, '$queryRawUnsafe'>,
  columns: readonly AddedColumn[] = ADDED_COLUMNS,
): Promise<AddedColumn[]> {
  const missing: AddedColumn[] = [];
  for (const table of new Set(columns.map((c) => c.table))) {
    const present = await client.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${quote(table)})`);
    if (present.length === 0) continue;
    const have = new Set(present.map((c) => c.name));
    missing.push(...columns.filter((c) => c.table === table && !have.has(c.column)));
  }
  return missing;
}

/**
 * Prisma's limit for the whole upgrade transaction. Its default, 5s, is also SQLite's busy timeout,
 * which the first ALTER may spend in full waiting for another writer; the rest must still fit.
 */
const UPGRADE_TRANSACTION_MS = 15_000;

/**
 * Add any listed column the database lacks, all in ONE transaction: one commit however many are
 * added (seven separate commits measured about 9.7s on a busy spinning disk), and a start that stops
 * part-way adds none. Returns `Table.column` for each one added, so the caller can say what it did.
 * A table that does not exist is left alone: creating tables is the DDL's job, and a file that is not
 * ours must not grow ours.
 *
 * The columns are read BEFORE the transaction, so its first statement is an ALTER. That is what lets
 * it wait for another process writing to the file: SQLite applies its busy timeout to a transaction
 * that starts by writing, but answers "database is locked" at once to one that read first (see
 * sqlitePragma.ts). Measured with another process holding the write lock for 1.5s: reading inside
 * the transaction failed in 0ms, and writing first waited, then succeeded.
 *
 * If another process adds one of the columns between the read and the ALTER, SQLite refuses the
 * duplicate and the transaction rolls back; this reads once more and adds only what is still missing.
 */
export async function addMissingColumns(
  client: PrismaClient,
  columns: readonly AddedColumn[] = ADDED_COLUMNS,
): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    const missing = await missingColumns(client, columns);
    if (missing.length === 0) return [];
    try {
      await client.$transaction(async (tx) => {
        for (const c of missing) await tx.$executeRawUnsafe(`ALTER TABLE ${quote(c.table)} ADD COLUMN ${quote(c.column)} ${c.type}`);
      }, { timeout: UPGRADE_TRANSACTION_MS });
      return missing.map((c) => `${c.table}.${c.column}`);
    } catch (e) {
      if (attempt === 1 && /duplicate column name/i.test((e as Error).message)) continue;
      throw e;
    }
  }
}
