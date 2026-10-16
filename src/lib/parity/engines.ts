/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The two databases the parity suites compare, stood up empty with the schema applied.
//
// ── How the schema gets there, and why not `prisma db push` ─────────────────────────────────────
//
// Each suite used to run `npx prisma db push --force-reset` twice (once per engine) plus a `node -e`
// child to create its database: three Prisma processes per setup, each blocking its worker and each
// loading Prisma and its engine from node_modules to do a few milliseconds of DDL, fifteen setups in
// a full run, several at a time. Measured on a Windows machine whose checkout is on a spinning disk:
// `npx prisma --version` took 82s with a cold file cache and 4s warm, and during a full run every
// suite's setup hook ran past 100s, several past the 120s limit. CI on Linux took 6-7s per suite
// for the same work.
//
// Now the PostgreSQL DDL is generated ONCE per run, by test/parityGlobalSetup.ts, from the same
// `prisma migrate diff --from-empty --to-schema` that `db push` applies to an empty database. The
// SQLite DDL is the committed prisma/sqlite-schema.sql, which CI checks is exactly that command's
// output for the SQLite schema. Each suite then creates its database and runs the DDL in-process,
// in ONE transaction per engine: one commit instead of one per statement, which on that disk is
// the difference between about 0.15s and 6-12s for SQLite alone.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLITE_TIMESTAMP_FORMAT, type SqliteAdapterOptions } from '../sqliteTimestamp';

const ROOT = resolve(__dirname, '..', '..', '..');

/** A real Postgres to compare against. Absent locally is tolerated; absent in CI is a failure. */
export const PARITY_DATABASE_URL = process.env.PARITY_DATABASE_URL?.trim() || '';

/**
 * How long a test in these files may take.
 *
 * Vitest allows 5s by default, which is a sensible budget for a unit test and the wrong one for
 * everything here: every test in this directory does real work against a real PostgreSQL and a real
 * SQLite file, while the rest of the suite runs in parallel around it and competes for the same
 * machine. A 16-table wipe that takes 200ms on an idle box was measured at over 5s during a full
 * suite run, and failed — for no reason connected to what it was checking.
 *
 * THIS IS NOT A RETRY, AND IT IS NOT A FLAKE BEING PAPERED OVER. The distinction is whether the
 * duration is part of what the test asserts. Nothing in these files asserts a deadline; they assert
 * that two engines agree, and a test that fails on elapsed time is reporting the state of the
 * machine, not of the code. What a timeout is genuinely for — catching something HUNG, a lock never
 * released, a query that never returns — is preserved: 30s still fails, and fails fast enough to be
 * useful, while being far outside the range contention can produce.
 *
 * If a parity test ever exceeds this, treat it as a real defect and not as a number to raise again.
 */
export const PARITY_TIMEOUT = 30_000;

export interface Engines {
  pg: PrismaClient;
  sqlite: PrismaClient;
  dispose: () => Promise<void>;
}

/** Split Prisma-generated DDL into statements: comment lines out, then on `;` (none sit in a literal). */
function statements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

let postgresDdl: string[] | undefined;
let sqliteDdl: string[] | undefined;

/** The PostgreSQL schema as DDL, written once per run by test/parityGlobalSetup.ts. */
function postgresSchema(): string[] {
  if (postgresDdl) return postgresDdl;
  const file = process.env.PARITY_POSTGRES_DDL_FILE;
  if (!file) throw new Error('PARITY_POSTGRES_DDL_FILE is not set: run the parity suites through vitest, whose global setup (test/parityGlobalSetup.ts) generates it.');
  postgresDdl = statements(readFileSync(file, 'utf8'));
  return postgresDdl;
}

/** The SQLite schema as DDL: the committed file a standalone gateway builds its database from. */
function sqliteSchema(): string[] {
  sqliteDdl ??= statements(readFileSync(join(ROOT, 'prisma', 'sqlite-schema.sql'), 'utf8'));
  return sqliteDdl;
}

/** Run DDL in one transaction, so it costs one commit and a failure leaves nothing half-built. */
async function applySchema(client: PrismaClient, ddl: string[]): Promise<void> {
  await client.$transaction(async (tx) => {
    for (const s of ddl) await tx.$executeRawUnsafe(s);
  }, { maxWait: PARITY_TIMEOUT, timeout: PARITY_TIMEOUT });
}

/**
 * Open the second generated client against a SQLite file.
 *
 * Required rather than imported for the same reason lib/prisma does it: the specifier only resolves
 * once `prisma generate` has run against the SQLite schema.
 *
 * Exported so that every SQLite test opens a client the one way. Prisma 7 replaced the `datasources`
 * option with a driver adapter, and the tests that had each built their own client were each a place
 * to get that wrong — or, later, to miss when it changes again.
 */
export function openSqlite(url: string): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SqliteClient = (require('.prisma/client-sqlite') as { PrismaClient: new (o?: unknown) => PrismaClient }).PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3') as {
    PrismaBetterSqlite3: new (opts: { url: string }, options?: SqliteAdapterOptions) => unknown;
  };
  // SQLITE_TIMESTAMP_FORMAT, not the adapter default: these suites exist to prove the two engines
  // agree, and a harness that wrote timestamps differently from the gateway would be comparing
  // something the product never does. See the note on that constant.
  return new SqliteClient({
    adapter: new PrismaBetterSqlite3({ url }, { timestampFormat: SQLITE_TIMESTAMP_FORMAT }),
    log: ['error'],
  }) as PrismaClient;
}

/**
 * Open the PostgreSQL client against a connection string.
 *
 * The counterpart to openSqlite, and exported for the same reason: Prisma 7 takes its connection
 * through a driver adapter rather than the `datasources` option, and five copies of that
 * construction is five places for the next change to be missed.
 */
export function openPostgres(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), log: ['error'] });
}

/**
 * Point a Postgres URL at a differently-named database on the same server.
 *
 * Every parity file needs its own, because each one empties its database and vitest runs files
 * concurrently: two of them resetting one database is a race that shows up as an occasional,
 * unreproducible CI failure. The SQLite side gets this for free from mkdtemp.
 */
function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** `nexus_parity` → `nexus_parity_analytics`. Restricted to an identifier we built ourselves. */
function databaseFor(namespace: string): string {
  const base = new URL(PARITY_DATABASE_URL).pathname.replace(/^\//, '') || 'nexus_parity';
  return `${base}_${namespace.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * An EMPTY Postgres database, dropped and recreated, with no schema in it.
 *
 * `startEngines` applies a schema, which is right for every suite that wants tables to compare. The
 * migration suite wants the opposite: a database in the state a customer's new one is in, so that
 * building the schema is the thing under test rather than a precondition. Dropped first because
 * "already exists with last run's tables" would make an idempotency assertion pass for the wrong
 * reason.
 *
 * Through a client on the configured database, because CREATE DATABASE cannot run inside a
 * transaction. `WITH (FORCE)` because a plain DROP fails outright with "database is being accessed by
 * other users" if ANY connection is still open to it, and a pool from the previous run of this same
 * file can outlive the client that opened it by a moment. PostgreSQL 13 and later terminate the
 * stragglers instead, which is what we want: the database is about to cease existing.
 */
export async function freshDatabase(namespace: string): Promise<string> {
  const name  = databaseFor(namespace).replace(/"/g, '""');
  const admin = openPostgres(PARITY_DATABASE_URL);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
  return withDatabase(PARITY_DATABASE_URL, databaseFor(namespace));
}

/** A SQLite gateway on its own throwaway file. Caller must dispose. */
export interface SqliteGateway {
  client: PrismaClient;
  /** The `file:` URL, for anything that needs the path rather than the client. */
  url: string;
  dispose: () => Promise<void>;
}

/** A client on a new file in a new temp directory, with the SQLite schema applied. */
async function newSqlite(prefix: string, file: string): Promise<{ client: PrismaClient; url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const url = `file:${join(dir, file)}`;
  const client = openSqlite(url);
  try {
    await applySchema(client, sqliteSchema());
  } catch (err) {
    await client.$disconnect();
    throw err;
  }
  return { client, url, dir };
}

const removeDir = (dir: string): void => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
};

/**
 * One SQLite gateway, with no PostgreSQL beside it.
 *
 * The inverse pairing from every other file here. The dialect suites want two engines holding the
 * SAME rows so the twins can be compared; the migration suite wants a populated SQLite as the
 * SOURCE and an EMPTY Postgres as the destination, because moving between them is the thing under
 * test. Calling `startEngines` for that would build a Postgres schema that the test then has to
 * ignore — and worse, would hand it a database that is already correct, which is the one state a
 * migration must never be tested against.
 */
export async function startSqlite(namespace: string): Promise<SqliteGateway> {
  const { client, url, dir } = await newSqlite(`nexus-${namespace.replace(/[^a-z0-9]/gi, '')}-`, 'gateway.db');
  return { client, url, dispose: async () => { await client.$disconnect(); removeDir(dir); } };
}

/**
 * Stand up both engines, empty, with the schema applied.
 *
 * The Postgres side is dropped and recreated, which is why PARITY_DATABASE_URL must name a throwaway
 * server and never a real one.
 *
 * @param namespace a short name unique to the calling test file, so concurrent files cannot reset
 *                  each other's database out from under them.
 */
export async function startEngines(namespace: string): Promise<Engines> {
  const pg = openPostgres(await freshDatabase(namespace));
  const [local, schema] = await Promise.allSettled([
    newSqlite('nexus-parity-', 'parity.db'),
    Promise.resolve().then(() => applySchema(pg, postgresSchema())),
  ]);
  if (local.status === 'rejected' || schema.status === 'rejected') {
    await pg.$disconnect();
    if (local.status === 'fulfilled') { await local.value.client.$disconnect(); removeDir(local.value.dir); }
    throw local.status === 'rejected' ? local.reason : (schema as PromiseRejectedResult).reason;
  }
  const { client: sqlite, dir } = local.value;
  return {
    pg,
    sqlite,
    dispose: async () => {
      await Promise.all([pg.$disconnect(), sqlite.$disconnect()]);
      removeDir(dir);
    },
  };
}
