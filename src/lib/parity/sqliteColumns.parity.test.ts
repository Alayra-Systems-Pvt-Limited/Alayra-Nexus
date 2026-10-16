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

// A standalone database created by 1.7.0, booted by this version (see lib/sqliteColumns.ts).
//
// The "old" file is built from the DDL 1.7.0 actually shipped, committed beside this test as
// src/lib/__fixtures__/sqlite-schema-1.7.0.sql (copied from the v1.7.0 tag), rather than by deleting
// lines from today's DDL: a fixture derived from the thing under test proves only that the
// derivation is consistent with itself.
//
// Needs no PostgreSQL, so unlike most parity files it always runs.

import { describe, it, expect, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSqliteSchema } from '../sqliteBootstrap';
import { ADDED_COLUMNS, addMissingColumns } from '../sqliteColumns';
import { configureSqlite } from '../sqlitePragma';
import { PARITY_TIMEOUT, openSqlite } from './harness';

const DDL     = readFileSync(resolve(__dirname, '..', '..', '..', 'prisma', 'sqlite-schema.sql'), 'utf8');
const DDL_170 = readFileSync(resolve(__dirname, '..', '__fixtures__', 'sqlite-schema-1.7.0.sql'), 'utf8');
const ADDED   = ADDED_COLUMNS.map((c) => `${c.table}.${c.column}`);
const KINDS   = { cachedInputTokens: 900, cacheWriteTokens: 50, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, cacheMissTokens: 100, reasoningTokens: 0 };
const dirs: string[] = [];

afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } } });

/** A path for a new database file, in a temp directory removed after the file. */
function newFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cols-'));
  dirs.push(dir);
  return join(dir, 'nexus.db');
}

function emptyDatabase(): PrismaClient {
  return openSqlite(`file:${newFile()}`);
}

/** The same naive split sqliteBootstrap uses, which is safe for Prisma-generated DDL. */
const statements = (sql: string) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);

/** The CREATE TABLE body for one table in a DDL file. */
const tableBody = (sql: string, table: string) => sql.split(`CREATE TABLE "${table}" (`)[1]?.split('\n);')[0] ?? '';

/**
 * The 1.7.0 database, built once per file and per journal mode and copied for each test that needs
 * one. Built in ONE transaction: run as 45 separate commits it took 6-12s on a spinning disk, and
 * over a minute per test during a full parallel run, where each commit waits for the disk; as one,
 * about 0.15s.
 *
 * 'wal' is the state 1.7.0 left a file in: its boot ran the same configureSqlite after building the
 * schema. 'delete' is a file where WAL was refused, on a network mount for one. Closing folds the
 * log back into the file, so the copy is the whole database.
 */
type Mode = 'wal' | 'delete';
const templates: Partial<Record<Mode, Promise<string>>> = {};

async function buildTemplate170(mode: Mode): Promise<string> {
  const file = newFile();
  const db = openSqlite(`file:${file}`);
  await db.$transaction(async (tx) => {
    for (const s of statements(DDL_170)) await tx.$executeRawUnsafe(s);
    await tx.$executeRawUnsafe(`INSERT INTO "TokenUsage" ("id", "sessionId", "modelId", "modelName", "provider", "inputTokens", "outputTokens", "totalTokens", "estimatedUsd")
      VALUES ('old-1', 's', 'gpt-4o', 'gpt-4o', 'openai', 1000, 500, 1500, 0.0075)`);
  }, { maxWait: 30_000, timeout: 30_000 });
  if (mode === 'wal') await configureSqlite(db);
  await db.$disconnect();
  return file;
}

/** A new file holding a database exactly as 1.7.0 created it, with one usage row. */
async function fileFrom170(mode: Mode = 'wal'): Promise<string> {
  templates[mode] ??= buildTemplate170(mode);
  const file = newFile();
  copyFileSync(await templates[mode], file);
  return file;
}

async function databaseFrom170(mode: Mode = 'wal'): Promise<PrismaClient> {
  return openSqlite(`file:${await fileFrom170(mode)}`);
}

const columnsOf = async (db: PrismaClient, table: string) =>
  (await db.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`)).map((c) => c.name);

const select = { inputTokens: true, outputTokens: true, totalTokens: true, estimatedUsd: true, ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, true])) };

describe('the column list', () => {
  it('names only nullable columns that the committed DDL has, with the same type', () => {
    for (const c of ADDED_COLUMNS) {
      const line = tableBody(DDL, c.table).split('\n').map((l) => l.trim()).find((l) => l.startsWith(`"${c.column}" `));
      // A table's last column has no trailing comma.
      expect(line?.replace(/,$/, ''), `${c.table}.${c.column} is not in prisma/sqlite-schema.sql`).toBe(`"${c.column}" ${c.type}`);
    }
  });

  it('names exactly what 1.7.0 lacked, so the fixture really is the old schema', () => {
    for (const c of ADDED_COLUMNS) expect(tableBody(DDL_170, c.table)).not.toContain(`"${c.column}"`);
    expect(tableBody(DDL_170, 'TokenUsage')).toContain('"savedUsd"');
  });
});

describe('booting a database created by 1.7.0', () => {
  it('fails today without the new columns, which is the breakage this prevents', async () => {
    const db = await databaseFrom170();
    await expect(db.tokenUsage.findMany({ select })).rejects.toThrow();
    await db.$disconnect();
  });

  it.each([['wal'], ['delete']] as const)('%s: adds the columns, keeps the row, and reads it as nothing reported', async (mode) => {
    const db = await databaseFrom170(mode);
    expect((await db.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode'))[0]?.journal_mode).toBe(mode);
    const r = await ensureSqliteSchema(db);
    expect(r).toMatchObject({ created: false, added: ADDED });

    const old = await db.tokenUsage.findUnique({ where: { id: 'old-1' }, select });
    expect(old).toEqual({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedUsd: 0.0075,
      ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, null])) });

    // And a new row with every kind is written and read back.
    await db.tokenUsage.createMany({ data: [{ id: 'new-1', sessionId: 's', modelId: 'm', modelName: 'm', provider: 'p', ...KINDS }] });
    expect(await db.tokenUsage.findUnique({ where: { id: 'new-1' }, select: Object.fromEntries(Object.keys(KINDS).map((k) => [k, true])) }))
      .toEqual(KINDS);
    await db.$disconnect();
  });

  it('adds nothing on the next boot', async () => {
    const db = await databaseFrom170();
    await ensureSqliteSchema(db);
    expect((await ensureSqliteSchema(db)).added).toEqual([]);
    await db.$disconnect();
  });

  it('ends with the same columns, in the same order, as a database created fresh', async () => {
    const upgraded = await databaseFrom170();
    await ensureSqliteSchema(upgraded);
    const fresh = emptyDatabase();
    const r = await ensureSqliteSchema(fresh);
    expect(r).toMatchObject({ created: true, added: [] });
    for (const table of new Set(ADDED_COLUMNS.map((c) => c.table))) {
      expect(await columnsOf(upgraded, table)).toEqual(await columnsOf(fresh, table));
    }
    await Promise.all([upgraded.$disconnect(), fresh.$disconnect()]);
  });

  it('leaves a database that is not ours alone', async () => {
    const db = emptyDatabase();
    await db.$executeRawUnsafe('CREATE TABLE "SomebodyElses" (id TEXT PRIMARY KEY)');
    expect((await ensureSqliteSchema(db)).added).toEqual([]);
    expect(await columnsOf(db, 'SomebodyElses')).toEqual(['id']);
    await db.$disconnect();
  });
});

/** Another process: takes the write lock on a file, says so, and lets go after some milliseconds. */
const HOLDER = `const Database = require(process.argv[1]); const db = new Database(process.argv[2]);
db.exec('BEGIN IMMEDIATE'); console.log('locked');
setTimeout(() => { db.exec('COMMIT'); console.log('released ' + Date.now()); db.close(); }, Number(process.argv[3]));`;

const without = (...gone: string[]) => ADDED.filter((c) => !gone.includes(c));

describe('an upgrade that fails, finds part of the work done, or meets another writer', () => {
  it('adds none of the columns when the last one fails', async () => {
    const db = await databaseFrom170();
    // The last column listed twice: the eighth ALTER fails after the other seven succeeded, and fails
    // again on the one re-read a duplicate earns.
    const last = ADDED_COLUMNS[ADDED_COLUMNS.length - 1];
    await expect(addMissingColumns(db, [...ADDED_COLUMNS, last])).rejects.toThrow(/duplicate column name/);
    for (const c of ADDED_COLUMNS) expect(await columnsOf(db, c.table)).not.toContain(c.column);
    await db.$disconnect();
  });

  it('adds only what a partly upgraded file lacks, ending in the same order as a fresh file', async () => {
    const db = await databaseFrom170();
    await db.$executeRawUnsafe('ALTER TABLE "TokenUsage" ADD COLUMN "cachedInputTokens" INTEGER');
    await db.$executeRawUnsafe('ALTER TABLE "NexusProvider" ADD COLUMN "nativeMessages" TEXT');
    expect((await ensureSqliteSchema(db)).added).toEqual(without('TokenUsage.cachedInputTokens', 'NexusProvider.nativeMessages'));
    const fresh = emptyDatabase();
    await ensureSqliteSchema(fresh);
    for (const table of ['TokenUsage', 'NexusProvider']) expect(await columnsOf(db, table)).toEqual(await columnsOf(fresh, table));
    await Promise.all([db.$disconnect(), fresh.$disconnect()]);
  });

  it('reads again and adds the rest when a column appears between its read and its write', async () => {
    const db = await databaseFrom170();
    // As a second gateway upgrading the same file would: one column lands just before the transaction.
    let raced = false;
    const racing = new Proxy(db, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key !== '$transaction' || raced) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        raced = true;
        await target.$executeRawUnsafe('ALTER TABLE "TokenUsage" ADD COLUMN "cachedInputTokens" INTEGER');
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } });
    expect(await addMissingColumns(racing)).toEqual(without('TokenUsage.cachedInputTokens'));
    expect(raced).toBe(true);
    await db.$disconnect();
  });

  it('waits for another process writing to the file, then adds every column', async () => {
    const file = await fileFrom170();
    const holder = spawn(process.execPath, ['-e', HOLDER, require.resolve('better-sqlite3'), file, '1500']);
    let out = '';
    holder.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const closed = new Promise<number | null>((r) => holder.on('close', r));
    await vi.waitFor(() => expect(out).toContain('locked'), { timeout: PARITY_TIMEOUT, interval: 20 });

    const db = openSqlite(`file:${file}`);
    const startedAt = Date.now();
    const r = await ensureSqliteSchema(db);
    const doneAt = Date.now();
    expect(await closed).toBe(0);
    expect(r.added).toEqual(ADDED);
    // The lock was still held when the upgrade began, and the upgrade ended after it was let go.
    const releasedAt = Number(/released (\d+)/.exec(out)?.[1]);
    expect(releasedAt).toBeGreaterThan(startedAt);
    expect(doneAt).toBeGreaterThanOrEqual(releasedAt);
    await db.$disconnect();
  }, PARITY_TIMEOUT);
});
