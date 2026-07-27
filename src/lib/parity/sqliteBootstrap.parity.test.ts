/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Does a standalone gateway build its own database? (Phase S2.4)
//
// Against a real, genuinely empty SQLite file — not a mock, and not one `prisma db push` already
// prepared, since that is the one condition this code exists to handle and the only one where a
// mistake is invisible. `SELECT 1` succeeds on an empty file, so every dependency check passes and
// the failure lands later as "no such table".
//
// Needs no PostgreSQL, so unlike the other parity files it always runs.

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSqliteSchema } from '../sqliteBootstrap';

const DDL_PATH = resolve(__dirname, '..', '..', '..', 'prisma', 'sqlite-schema.sql');
const dirs: string[] = [];

/** A brand-new, entirely empty database file — no schema, no tables. */
function emptyDatabase(): PrismaClient {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-boot-'));
  dirs.push(dir);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Client = (require('.prisma/client-sqlite') as { PrismaClient: new (o?: unknown) => PrismaClient }).PrismaClient;
  return new Client({ datasources: { db: { url: `file:${join(dir, 'nexus.db')}` } }, log: ['error'] });
}

afterAll(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } }
});

describe('ensureSqliteSchema', () => {
  it('an empty file really is empty, and still answers SELECT 1', async () => {
    // Both halves matter: it establishes the precondition for every test below, and it demonstrates
    // why preflight cannot catch this — the gateway looks perfectly healthy at this point.
    const db = emptyDatabase();
    const tables = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    expect(Number(tables[0].n)).toBe(0);
    await expect(db.$queryRawUnsafe('SELECT 1')).resolves.toBeDefined();
    await db.$disconnect();
  });

  it('creates the whole schema on a first run', async () => {
    const db = emptyDatabase();
    const r = await ensureSqliteSchema(db);

    expect(r.created).toBe(true);
    expect(r.tables).toBe(16);            // every model in the schema, not merely "some"

    // And the tables actually work, which a CREATE that silently produced nothing would not.
    await db.appSettings.create({ data: { key: 'first-run', value: 'ok' } });
    expect((await db.appSettings.findUnique({ where: { key: 'first-run' } }))?.value).toBe('ok');
    await db.$disconnect();
  });

  it('creates the indexes too, not just the tables', async () => {
    // A schema with tables and no indexes would pass every functional test and quietly degrade
    // every query the dashboard makes.
    const db = emptyDatabase();
    await ensureSqliteSchema(db);

    const idx = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`);
    expect(Number(idx[0].n)).toBeGreaterThanOrEqual(20);
    await db.$disconnect();
  });

  it('enforces the constraints it created', async () => {
    const db = emptyDatabase();
    await ensureSqliteSchema(db);

    await db.appSettings.create({ data: { key: 'dup', value: 'a' } });
    // `key` is @unique. If the DDL had lost that, two rows would land and nothing would complain.
    await expect(db.appSettings.create({ data: { key: 'dup', value: 'b' } })).rejects.toMatchObject({ code: 'P2002' });
    await db.$disconnect();
  });

  it('applies column defaults, which the app relies on for every omitted field', async () => {
    const db = emptyDatabase();
    await ensureSqliteSchema(db);

    const row = await db.tokenUsage.create({
      data: { id: 'd1', sessionId: 's', modelId: 'm', modelName: 'm', provider: 'p' },
    });
    expect(row.outcome).toBe('success');   // every analytics aggregate filters on this
    expect(row.unit).toBe('token');
    expect(row.cached).toBe(false);
    expect(row.createdAt).toBeInstanceOf(Date);
    await db.$disconnect();
  });

  it('is a no-op on a database that already has tables', async () => {
    // Second boot. The DDL is plain CREATE TABLE and would throw; the guard is the table count.
    const db = emptyDatabase();
    await ensureSqliteSchema(db);
    await db.appSettings.create({ data: { key: 'survives', value: 'yes' } });

    const second = await ensureSqliteSchema(db);
    expect(second.created).toBe(false);
    expect(second.tables).toBe(16);

    // The data is still there — this must never be mistaken for a reset.
    expect((await db.appSettings.findUnique({ where: { key: 'survives' } }))?.value).toBe('yes');
    await db.$disconnect();
  });

  it('leaves a foreign database alone rather than trying to "help"', async () => {
    // Somebody points DATABASE_URL at a SQLite file that is not ours. Creating our schema beside
    // their tables would be a gateway modifying data it was never asked to touch.
    const db = emptyDatabase();
    await db.$executeRawUnsafe('CREATE TABLE "SomebodyElses" (id TEXT PRIMARY KEY)');

    const r = await ensureSqliteSchema(db);
    expect(r.created).toBe(false);
    expect(r.tables).toBe(1);

    const names = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    expect(names.map((n) => n.name)).toEqual(['SomebodyElses']);
    await db.$disconnect();
  });

  it('rolls back completely if a statement fails', async () => {
    // A half-created schema is the worst outcome: the next boot finds tables, skips creation, and
    // fails on whichever ones are missing — with no hint that the first run was the problem.
    const db = emptyDatabase();
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TABLE "Partial" (id TEXT PRIMARY KEY)');
      await tx.$executeRawUnsafe('CREATE TABLE "Partial" (id TEXT PRIMARY KEY)');   // already exists
    })).rejects.toThrow();

    const tables = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    expect(Number(tables[0].n)).toBe(0);
    await db.$disconnect();
  });
});

describe('the committed prisma/sqlite-schema.sql', () => {
  const ddl = readFileSync(DDL_PATH, 'utf8');

  it('creates every model in the schema', () => {
    // Counted FROM the schema rather than hardcoded, so adding a model without regenerating the DDL
    // fails here — the failure it prevents is a first-time user whose new database silently lacks
    // whatever shipped most recently.
    const schema = readFileSync(resolve(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const models = (schema.match(/^model\s+\w+\s*\{/gm) ?? []).length;

    expect(models).toBeGreaterThan(10);                       // guards the regex, not just the result
    expect((ddl.match(/CREATE TABLE/gi) ?? []).length).toBe(models);
  });

  it('warns a reader not to edit it', () => {
    expect(ddl).toMatch(/GENERATED FILE — DO NOT EDIT/);
  });

  it('splits into as many statements as it has CREATEs', () => {
    // Guards the naive semicolon split in sqliteBootstrap. If the schema ever grows a trigger or a
    // string literal containing a semicolon, this fails here rather than half-building a database
    // on somebody's first run.
    const creates = (ddl.match(/^CREATE /gim) ?? []).length;
    const stmts = ddl
      .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(creates);
  });

  it('contains no statement that could destroy data', () => {
    // This file is executed by a running gateway against whatever DATABASE_URL points at, so every
    // statement in it must only ever create. Checked per STATEMENT rather than by searching the
    // text: "ON DELETE CASCADE" is a foreign-key clause inside a CREATE TABLE, and a substring
    // search flags it as destructive — which is a false alarm that would train someone to ignore
    // this test.
    const stmts = ddl
      .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);

    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s, `not a CREATE statement: ${s.slice(0, 60)}`).toMatch(/^CREATE (TABLE|INDEX|UNIQUE INDEX)\b/i);
    }
  });
});
