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
// already had. 1.8.0 adds six to TokenUsage, and a file created by an older version would fail
// every usage write that carried one ("no such column"), the usage-by-day read and every backup:
// the generated client names each column of the model, whether or not the file has it.
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
  type:   'INTEGER';
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
];

/** SQL identifiers here come from the constant above, never from input; quoting is for the casing. */
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Add any listed column the database lacks. Returns `Table.column` for each one added, so the caller
 * can say what it did. A table that does not exist is left alone: creating tables is the DDL's job,
 * and a file that is not ours must not grow ours.
 */
export async function addMissingColumns(
  client: Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>,
  columns: readonly AddedColumn[] = ADDED_COLUMNS,
): Promise<string[]> {
  const added: string[] = [];
  const tables = [...new Set(columns.map((c) => c.table))];
  for (const table of tables) {
    const present = await client.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${quote(table)})`);
    if (present.length === 0) continue;
    const have = new Set(present.map((c) => c.name));
    for (const c of columns) {
      if (c.table !== table || have.has(c.column)) continue;
      await client.$executeRawUnsafe(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(c.column)} ${c.type}`);
      added.push(`${table}.${c.column}`);
    }
  }
  return added;
}
