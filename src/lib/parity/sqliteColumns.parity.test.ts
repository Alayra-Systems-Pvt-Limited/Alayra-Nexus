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

import { describe, it, expect, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSqliteSchema } from '../sqliteBootstrap';
import { ADDED_COLUMNS } from '../sqliteColumns';
import { openSqlite } from './harness';

const DDL     = readFileSync(resolve(__dirname, '..', '..', '..', 'prisma', 'sqlite-schema.sql'), 'utf8');
const DDL_170 = readFileSync(resolve(__dirname, '..', '__fixtures__', 'sqlite-schema-1.7.0.sql'), 'utf8');
const ADDED   = ADDED_COLUMNS.map((c) => `${c.table}.${c.column}`);
const KINDS   = { cachedInputTokens: 900, cacheWriteTokens: 50, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, cacheMissTokens: 100, reasoningTokens: 0 };
const dirs: string[] = [];

afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } } });

function emptyDatabase(): PrismaClient {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cols-'));
  dirs.push(dir);
  return openSqlite(`file:${join(dir, 'nexus.db')}`);
}

/** The same naive split sqliteBootstrap uses, which is safe for Prisma-generated DDL. */
const statements = (sql: string) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);

/** The CREATE TABLE body for one table in a DDL file. */
const tableBody = (sql: string, table: string) => sql.split(`CREATE TABLE "${table}" (`)[1]?.split('\n);')[0] ?? '';

/** A database exactly as 1.7.0 created it, holding one usage row. */
async function databaseFrom170(): Promise<PrismaClient> {
  const db = emptyDatabase();
  for (const s of statements(DDL_170)) await db.$executeRawUnsafe(s);
  await db.$executeRawUnsafe(`INSERT INTO "TokenUsage" ("id", "sessionId", "modelId", "modelName", "provider", "inputTokens", "outputTokens", "totalTokens", "estimatedUsd")
    VALUES ('old-1', 's', 'gpt-4o', 'gpt-4o', 'openai', 1000, 500, 1500, 0.0075)`);
  return db;
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

  it('adds the columns, keeps the row, and reads it as nothing reported', async () => {
    const db = await databaseFrom170();
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
