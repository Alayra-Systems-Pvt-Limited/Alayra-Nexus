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

// Moving a standalone gateway onto PostgreSQL (Phase S3).
//
// The decisions live next door in lib/migrateTarget (pure, tested without a database); this is the
// I/O. lib/prismaCli owns the one thing neither can do in-process — creating the schema.
//
// ── Why the rows are copied rather than exported and restored ─────────────────────────────────
//
// Backup/restore already moves a gateway between engines, and it was tempting to reuse wholesale.
// It is the wrong tool here for two reasons. Both ends of THIS move share one master key, so the
// secrets in every row are ciphertext that stays readable after a plain copy — a `.nxb` round trip
// would decrypt and re-encrypt every one of them to arrive at the same bytes. And it would write
// the entire database to disk as a temporary file first, on a machine whose disk is the reason the
// operator is leaving.
//
// What IS reused is the part that matters: `MODEL_ORDER`, parents-first, checked against the schema
// by its own test. A migration that inserted a child before its parent would fail on a foreign key
// in exactly the way a restore would.
//
// ── Why the gateway refuses traffic while this runs ───────────────────────────────────────────
//
// A copy is a snapshot taken over time. Anything written to the source after its table has been
// read would never reach Postgres, and the operator would find out weeks later, missing a day of
// usage records and unable to say which. Maintenance mode — the same flag a `replace` restore
// raises — makes every proxy request answer 503 with a Retry-After for the duration. A migration
// that is quietly lossy is far worse than one that is briefly loud.
//
// ── What this never does ──────────────────────────────────────────────────────────────────────
//
// It never deletes the source, and it never switches the gateway over. The operator changes
// DATABASE_URL and restarts, having read a report that says every table matched. Until they do,
// the old gateway is still there and still works — which is what makes this safe to attempt.

import { PrismaClient } from '@prisma/client';
import { prisma, dbEngine } from '../lib/prisma';
import { beginMaintenance, reportProgress, endMaintenance } from './maintenance.service';
import { migrateDeploy, scrubUrls } from '../lib/prismaCli';
import {
  targetUrlProblem, describeTarget, countMismatches, totalRows, readableDbError,
  MIGRATE_ORDER, NOT_MIGRATED, type TableCounts, type CountMismatch,
} from '../lib/migrateTarget';
import { modelName } from '../lib/backup/modelOrder';

/** A Prisma delegate, reduced to the calls this module makes. */
interface Delegate {
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
  createMany(args: unknown): Promise<{ count: number }>;
  count(): Promise<number>;
}

const delegates = (client: PrismaClient): Record<string, Delegate> =>
  client as unknown as Record<string, Delegate>;

/**
 * Rows per round trip.
 *
 * Read in pages so a large `TokenUsage` never lands in memory whole, and written in batches so the
 * move is not one INSERT per row across a network that may be a continent away.
 */
const PAGE = 500;

export interface TargetReport {
  reachable: boolean;
  /** What the server said it is, for the operator to recognise. */
  version: string | null;
  /** Nexus tables already present and holding rows. Empty is the only state this will migrate into. */
  occupied: string[];
  /** Redacted, safe to display and to audit. */
  describes: string;
  problem: string | null;
}

/** Open a client against a database that is not this gateway's own. Caller must disconnect. */
function openTarget(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
}

/**
 * Look at the target without changing it.
 *
 * Runs before anything is created, so it cannot assume the schema exists — the table list comes
 * from `information_schema`, which answers on any Postgres whether or not Nexus has ever touched it.
 */
export async function inspectTarget(url: string): Promise<TargetReport> {
  const describes = describeTarget(url);
  const problem = targetUrlProblem(url);
  if (problem) return { reachable: false, version: null, occupied: [], describes, problem };

  const client = openTarget(url);
  try {
    const [{ version }] = await client.$queryRaw<{ version: string }[]>`SELECT version()`;

    const present = await client.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
    `;
    const here = new Set(present.map((r) => r.table_name));

    // Only OUR tables are considered, and only ones that actually hold something. A database with
    // the schema already applied but no rows is the normal state after a failed first attempt, and
    // refusing that would leave the operator stuck with no way forward but dropping the database.
    const occupied: string[] = [];
    for (const model of MIGRATE_ORDER) {
      const table = modelName(model);
      if (!here.has(table)) continue;
      // The table name comes from MODEL_ORDER, never from the request, so it cannot carry anything
      // an operator typed. Quoted because Prisma's names are case-sensitive in Postgres.
      const [row] = await client.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
      if (Number(row?.n ?? 0) > 0) occupied.push(table);
    }

    return { reachable: true, version: version ?? null, occupied, describes, problem: null };
  } catch (err) {
    return {
      reachable: false, version: null, occupied: [], describes,
      // Scrubbed first, because a connection failure from Postgres frequently quotes the whole
      // datasource back; then reduced to the sentence that says what an operator should change.
      problem: readableDbError(scrubUrls((err as Error).message)),
    };
  } finally {
    await client.$disconnect().catch(() => { /* nothing left to do about it */ });
  }
}

/** Count every migratable model on a client. */
async function countAll(client: PrismaClient): Promise<TableCounts> {
  const d = delegates(client);
  const counts: TableCounts = {};
  for (const model of MIGRATE_ORDER) counts[model] = await d[model].count();
  return counts;
}

/**
 * Copy every migratable model, parents first.
 *
 * `createMany` is used on the TARGET only, which is always Postgres — the note in lib/prisma about
 * SQLite lacking it applies to the source, which is only ever read here.
 */
async function copyRows(
  target: PrismaClient,
  onProgress: (written: number) => void,
): Promise<number> {
  const from = delegates(prisma);
  const to = delegates(target);
  let written = 0;

  for (const model of MIGRATE_ORDER) {
    let cursor: string | undefined;

    // Cursor paging, not skip/take: an offset makes the database re-scan everything it has already
    // handed over, so the cost of the last page grows with the table.
    for (;;) {
      const page = await from[model].findMany({
        take: PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;

      await to[model].createMany({ data: page });
      written += page.length;
      onProgress(written);

      cursor = page[page.length - 1].id as string;
      if (page.length < PAGE) break;
    }
  }

  return written;
}

export interface MigrationOutcome {
  ok: boolean;
  /** Redacted, safe for the screen and the audit trail. */
  target: string;
  rowsCopied?: number;
  sourceCounts?: TableCounts;
  targetCounts?: TableCounts;
  mismatches?: CountMismatch[];
  /** Models deliberately left behind, so the report can name them. */
  notMigrated: readonly string[];
  error?: string;
  /** Prisma's own words when the schema step failed. */
  detail?: string;
}

/**
 * Move this gateway's data into `url`.
 *
 * Refuses rather than guesses at every point where continuing would be a decision the operator did
 * not make: already on Postgres, an unreachable address, a database that holds someone else's Nexus
 * data, a schema that would not build, a row count that does not match afterwards.
 */
export async function migrateToPostgres(url: string): Promise<MigrationOutcome> {
  const target = describeTarget(url);
  const notMigrated = NOT_MIGRATED;

  // Nothing to move, and continuing would copy a Postgres onto itself if the operator pasted their
  // own address. The check is the engine rather than the URL because that is the fact that matters.
  if (dbEngine !== 'sqlite') {
    return {
      ok: false, target, notMigrated,
      error: 'This gateway is already running on PostgreSQL, so there is nothing to move.',
    };
  }

  const seen = await inspectTarget(url);
  if (seen.problem) return { ok: false, target, notMigrated, error: seen.problem };
  if (seen.occupied.length > 0) {
    return {
      ok: false, target, notMigrated,
      error:
        `${target} already holds Nexus data (${seen.occupied.join(', ')}). This moves into an empty `
        + 'database and will not write over one that is in use — point it at a new database, or empty '
        + 'this one deliberately first.',
    };
  }

  // Schema BEFORE maintenance mode. It is the slowest step and the one most likely to fail, and
  // there is no reason to refuse the gateway's traffic while a migration that may never start is
  // still deciding whether it can.
  const built = await migrateDeploy(url);
  if (!built.ok) {
    return {
      ok: false, target, notMigrated,
      error: `The schema could not be created in ${target}.`,
      detail: built.output,
    };
  }

  const sourceCounts = await countAll(prisma);
  const expected = totalRows(sourceCounts);

  await beginMaintenance(`this gateway is being moved to ${target}`, expected);

  // ONE client for the copy and the verification, disconnected exactly once below. Opening a second
  // for the counts would leave a live pool against the operator's new database after the request
  // returned, and managed Postgres providers charge for — and cap — exactly that.
  const client = openTarget(url);
  try {
    const rowsCopied = await copyRows(client, (n) => {
      void reportProgress(n).catch(() => { /* progress is a courtesy, never the operation */ });
    });

    const targetCounts = await countAll(client);
    const mismatches = countMismatches(sourceCounts, targetCounts);
    if (mismatches.length > 0) {
      return {
        ok: false, target, notMigrated, rowsCopied, sourceCounts, targetCounts, mismatches,
        error:
          'The move finished but the row counts do not match, so it is NOT safe to switch over. '
          + 'The gateway you are on is untouched — leave DATABASE_URL alone and try again into an '
          + 'empty database.',
      };
    }

    return { ok: true, target, notMigrated, rowsCopied, sourceCounts, targetCounts, mismatches: [] };
  } catch (err) {
    return { ok: false, target, notMigrated, error: readableDbError(scrubUrls((err as Error).message)) };
  } finally {
    await client.$disconnect().catch(() => { /* nothing left to do about it */ });
    // Always lowered. A gateway left refusing every request because a migration threw would turn a
    // failed move into an outage.
    await endMaintenance().catch(() => { /* the TTL is the backstop */ });
  }
}
