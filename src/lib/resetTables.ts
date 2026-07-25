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

// Emptying every table, on either engine (Phase S2.2).
//
// Lives here, taking its client as an argument, rather than inside firstRun.service where it is
// used. That is not tidiness: factory reset had no unit test whatsoever — only an end-to-end test
// that runs against PostgreSQL — so a SQLite branch written inside the service would have shipped
// with literally nothing exercising it. Taking the client as a parameter is what lets the parity
// suite run this against a real PostgreSQL AND a real SQLite and check both actually emptied.
//
// The two engines need genuinely different code, not just different SQL:
//
//   * Postgres has `TRUNCATE … RESTART IDENTITY CASCADE` — one statement that empties everything
//     at once, so atomicity and foreign-key ordering come free.
//   * SQLite has no TRUNCATE at all. The equivalent is `DELETE FROM` per table, which is N
//     statements — and a failure partway through would leave a HALF-RESET gateway: no accounts but
//     all the usage history, or every table but one. Worse than either outcome, and it would look
//     like it worked. So the deletes run in a single transaction with foreign-key enforcement
//     deferred to commit time, which makes order irrelevant and the whole wipe all-or-nothing.
//
// In both cases the table list comes from the LIVE SCHEMA rather than a hand-written array. A
// hand-written list is a wipe that silently spares whatever model ships next, leaving a "reset"
// gateway still holding the data someone asked to destroy.

import type { PrismaClient } from '@prisma/client';
import type { DbEngine } from './mode';

/** Escape a table name for interpolation. These come from the engine's own catalogue, never input. */
const quote = (name: string): string => name.replace(/"/g, '""');

/**
 * Empty every application table. Returns how many were cleared.
 *
 * Only the migrations ledger and the engine's internal bookkeeping survive: the schema itself is
 * not what is being reset.
 */
export async function emptyEveryTable(client: PrismaClient, engine: DbEngine): Promise<number> {
  if (engine === 'sqlite') {
    // `sqlite_%` covers sqlite_master, sqlite_sequence and the per-table autoindex entries — none
    // of which are ours to delete, and one of which cannot be deleted at all.
    const rows = await client.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'
    `;
    if (rows.length === 0) return 0;

    await client.$transaction(async (tx) => {
      // Defer foreign keys to commit rather than disabling them: every table ends empty, so nothing
      // is actually violated at commit, and a bug that WOULD leave a dangling reference still fails
      // loudly instead of being waved through.
      await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
      for (const r of rows) await tx.$executeRawUnsafe(`DELETE FROM "${quote(r.name)}"`);
    });
    return rows.length;
  }

  const rows = await client.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return 0;

  const tables = rows.map((r) => `"public"."${quote(r.tablename)}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  return rows.length;
}
