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

// What the durable store can say about itself (Phase S2.3).
//
// The Health panel's database card was seven pg_catalog queries, each `.catch(() => [])`-guarded so
// a managed instance that refuses one view still shows the rest. That guard is why SQLite did not
// break the page — and exactly why it needed fixing: every query failed, every fact came back null,
// and the panel rendered a wall of "—" that reads as "we could not reach your database" rather than
// "these numbers do not exist for a file".
//
// The honest split is not one dialect per query. Some of these facts are genuinely Postgres-only:
// SQLite is a file opened by one process, so it has no connection pool to be near the limit of, no
// server-side buffer cache to hit or miss, and no cumulative commit counter. Reporting zero for
// those would be a lie; reporting null is the truth, and the UI is what must say why.
//
// In exchange SQLite offers facts Postgres has no analogue for — the journal mode, which decides
// whether readers block writers, and the free-page count, which is space the file is holding but
// not using. Those are the numbers an operator of a file-backed gateway actually acts on.
//
// Established against a real generated SQLite client rather than from documentation: `dbstat` is
// compiled in, so per-table sizes are real (not estimated), and joining it to sqlite_master is what
// attributes an index's bytes to the table that owns it — the equivalent of Postgres's
// pg_total_relation_size, which counts indexes too.

import type { PrismaClient } from '@prisma/client';
import type { DbEngine } from './mode';

export interface DbTableSize {
  name:  string;
  rows:  number;
  bytes: number;
}

export interface DbStats {
  /** Engine version, e.g. "16.2" or "3.45.0". */
  version: string | null;

  // ── Facts only a client/server database has ────────────────────────────────────────────────
  // Null on SQLite, and null because the concept does not exist there — not because a query
  // failed. The panel must not present these as missing readings.
  maxConnections:    number | null;
  connections:       { total: number; active: number; idle: number } | null;
  cacheHitRatio:     number | null;
  commits:           number | null;   // cumulative, since the engine's stats were last reset
  rollbacks:         number | null;
  deadlocks:         number | null;
  tempBytes:         number | null;
  longestTxnSeconds: number | null;

  // ── Facts both engines have ───────────────────────────────────────────────────────────────
  databaseBytes: number | null;
  largestTables: DbTableSize[];

  // ── Facts only a single-file database has ─────────────────────────────────────────────────
  /** "wal" or "delete". WAL lets readers run during a write; "delete" does not. */
  journalMode:      string | null;
  pageSize:         number | null;
  /** Space the file holds but is not using — reclaimable by VACUUM. */
  reclaimableBytes: number | null;
}

const TOP_TABLES = 5;

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
};

/** Everything this engine can honestly report. Never throws: an absent fact is null. */
export async function readDbStats(client: PrismaClient, engine: DbEngine): Promise<DbStats> {
  return engine === 'sqlite' ? readSqliteStats(client) : readPostgresStats(client);
}

/** The shape both branches start from, so a field can never be silently omitted by one of them. */
const EMPTY: DbStats = {
  version: null,
  maxConnections: null, connections: null, cacheHitRatio: null,
  commits: null, rollbacks: null, deadlocks: null, tempBytes: null, longestTxnSeconds: null,
  databaseBytes: null, largestTables: [],
  journalMode: null, pageSize: null, reclaimableBytes: null,
};

async function readSqliteStats(client: PrismaClient): Promise<DbStats> {
  // Each guarded independently, for the same reason the Postgres branch is: a build of SQLite
  // compiled without dbstat must cost the table breakdown, not the whole panel.
  const [versionRow, fileRow, journalRow, tableRows] = await Promise.all([
    client.$queryRawUnsafe<{ v: string }[]>(`SELECT sqlite_version() AS v`).catch(() => []),
    client.$queryRawUnsafe<{ pageSize: number; pages: number; free: number }[]>(`
      SELECT (SELECT * FROM pragma_page_size())     AS "pageSize",
             (SELECT * FROM pragma_page_count())    AS pages,
             (SELECT * FROM pragma_freelist_count()) AS free`).catch(() => []),
    client.$queryRawUnsafe<{ journal_mode: string }[]>(`SELECT * FROM pragma_journal_mode()`).catch(() => []),
    // dbstat rows are per B-tree — one for the table, one per index. Joining sqlite_master maps
    // each back to the table that owns it, so an index's bytes land on its table rather than
    // appearing as a separate "table" the operator has never heard of.
    client.$queryRawUnsafe<{ name: string; bytes: number }[]>(`
      SELECT m.tbl_name AS name, CAST(SUM(d.pgsize) AS REAL) AS bytes
      FROM dbstat d JOIN sqlite_master m ON m.name = d.name
      WHERE m.tbl_name NOT LIKE 'sqlite_%' AND m.tbl_name <> '_prisma_migrations'
      GROUP BY m.tbl_name
      ORDER BY bytes DESC
      LIMIT ${TOP_TABLES}`).catch(() => []),
  ]);

  const pageSize = num(fileRow[0]?.pageSize);
  const pages    = num(fileRow[0]?.pages);
  const free     = num(fileRow[0]?.free);

  // Postgres reports n_live_tup, a free estimate maintained by its stats collector. SQLite keeps no
  // such counter, so this is an exact COUNT(*) — bounded to the five largest tables so the cost
  // stays fixed rather than growing with the schema.
  const largestTables: DbTableSize[] = [];
  for (const t of tableRows) {
    const rows = await client
      .$queryRawUnsafe<{ n: number }[]>(`SELECT CAST(COUNT(*) AS REAL) AS n FROM "${t.name.replace(/"/g, '""')}"`)
      .catch(() => []);
    largestTables.push({ name: t.name, rows: num(rows[0]?.n) ?? 0, bytes: num(t.bytes) ?? 0 });
  }

  return {
    ...EMPTY,
    version:          versionRow[0]?.v ?? null,
    databaseBytes:    pageSize !== null && pages !== null ? pageSize * pages : null,
    largestTables,
    journalMode:      journalRow[0]?.journal_mode ?? null,
    pageSize,
    reclaimableBytes: pageSize !== null && free !== null ? pageSize * free : null,
  };
}

async function readPostgresStats(client: PrismaClient): Promise<DbStats> {
  const [versionRow, settingsRow, connRows, dbRows, sizeRow, txnRow, tableRows] = await Promise.all([
    client.$queryRaw<{ v: string }[]>`SELECT version() AS v`.catch(() => []),
    client.$queryRaw<{ v: string }[]>`SELECT setting AS v FROM pg_settings WHERE name = 'max_connections'`.catch(() => []),
    client.$queryRaw<{ total: number; active: number; idle: number }[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE state = 'active')::int AS active,
             COUNT(*) FILTER (WHERE state = 'idle')::int   AS idle
      FROM pg_stat_activity WHERE datname = current_database()`.catch(() => []),
    client.$queryRaw<{ commits: number; rollbacks: number; blksRead: number; blksHit: number; deadlocks: number; tempBytes: number }[]>`
      SELECT xact_commit::float8 AS commits, xact_rollback::float8 AS rollbacks,
             blks_read::float8 AS "blksRead", blks_hit::float8 AS "blksHit",
             deadlocks::float8 AS deadlocks, temp_bytes::float8 AS "tempBytes"
      FROM pg_stat_database WHERE datname = current_database()`.catch(() => []),
    client.$queryRaw<{ bytes: number }[]>`SELECT pg_database_size(current_database())::float8 AS bytes`.catch(() => []),
    client.$queryRaw<{ secs: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM MAX(now() - xact_start))::float8 AS secs
      FROM pg_stat_activity WHERE state <> 'idle' AND xact_start IS NOT NULL`.catch(() => []),
    client.$queryRaw<{ name: string; rows: number; bytes: number }[]>`
      SELECT relname AS name, n_live_tup::float8 AS rows, pg_total_relation_size(relid)::float8 AS bytes
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5`.catch(() => []),
  ]);

  const db = dbRows[0];
  const blksRead = num(db?.blksRead), blksHit = num(db?.blksHit);
  const reads = (blksRead ?? 0) + (blksHit ?? 0);
  // "PostgreSQL 16.2 on x86_64…" → "16.2"
  //
  // Both `?.`s are load-bearing. The first guards a missing row (the query is `.catch(() => [])`, so
  // a failure arrives as an empty array); the second guards a row whose column is null or absent. It
  // was `?.v.match(...)` — row-guarded but column-unguarded — which turns any unexpected shape from
  // `SELECT version()` into a TypeError that takes the whole Health response down, rather than the
  // "version —" the UI already knows how to render.
  const version = versionRow[0]?.v?.match(/PostgreSQL\s+([\d.]+)/)?.[1] ?? null;

  return {
    ...EMPTY,
    version,
    maxConnections: settingsRow[0] ? Number(settingsRow[0].v) || null : null,
    connections:    connRows[0] ?? null,
    cacheHitRatio:  blksHit !== null && reads > 0 ? blksHit / reads : null,
    commits:        num(db?.commits),
    rollbacks:      num(db?.rollbacks),
    deadlocks:      num(db?.deadlocks),
    tempBytes:      num(db?.tempBytes),
    databaseBytes:  num(sizeRow[0]?.bytes),
    longestTxnSeconds: num(txnRow[0]?.secs),
    largestTables:  tableRows.map((t) => ({ name: t.name, rows: num(t.rows) ?? 0, bytes: num(t.bytes) ?? 0 })),
  };
}
