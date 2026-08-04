/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Is the standalone database actually in WAL? (Phase S2.5)
//
// Against real SQLite files, because the thing being checked is a property of a FILE — the journal
// mode lives in its header — and a mock would only ever confirm that we sent the string we sent.
//
// NOTHING HERE IS TIMED. The reason WAL is worth having is a throughput difference, and asserting a
// duration on a shared CI runner is the textbook flaky gate: it fails for reasons unrelated to the
// change in front of it and trains people to hit rerun. The measurement lives in
// scripts/bench/sqliteJournal.ts, where a human runs it deliberately. What is asserted here is only
// what is deterministic — that the mode is set, is real, persists, survives a second call, and is
// reported honestly when it cannot be set at all.
//
// Needs no PostgreSQL, so like sqliteBootstrap.parity.test.ts it always runs.

import { describe, it, expect, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSqlite } from '../sqlitePragma';
import { openSqlite } from './harness';

const dirs: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-wal-'));
  dirs.push(dir);
  return dir;
}

function openAt(file: string): PrismaClient {
  return openSqlite(`file:${file}`);
}

/** A database with one table, so there is something to write and something to read. */
async function seeded(file: string): Promise<PrismaClient> {
  const db = openAt(file);
  await db.$executeRawUnsafe('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return db;
}

const journalMode = async (db: PrismaClient): Promise<string> =>
  (await db.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode'))[0].journal_mode.toLowerCase();

/** A client that answers the pragma however a test needs, without a database behind it. */
function fakeClient(answer: () => unknown): PrismaClient {
  return { $queryRawUnsafe: async () => answer() } as unknown as PrismaClient;
}

afterAll(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } }
});

describe('configureSqlite', () => {
  it('starts from "delete", which is the whole reason this exists', async () => {
    // The premise. If a future Prisma ever defaults to WAL, this fails and the module becomes a
    // no-op worth deleting — which is exactly the notice we would want.
    const db = await seeded(join(newDir(), 'n.db'));
    expect(await journalMode(db)).toBe('delete');
    await db.$disconnect();
  });

  it('puts the file into WAL and says so', async () => {
    const db = await seeded(join(newDir(), 'n.db'));
    const r = await configureSqlite(db);

    expect(r.wal).toBe(true);
    expect(r.journalMode).toBe('wal');
    expect(r.warning).toBeUndefined();
    await db.$disconnect();
  });

  it('is really in WAL, not merely reported as such', async () => {
    // Asserted against the filesystem rather than the pragma we just issued: WAL commits land in a
    // `-wal` sidecar, so its appearance after a write is independent evidence that the mode took.
    const dir = newDir(), file = join(dir, 'n.db');
    const db = await seeded(file);
    await configureSqlite(db);
    await db.$executeRawUnsafe(`INSERT INTO t (v) VALUES ('x')`);

    expect(existsSync(`${file}-wal`)).toBe(true);
    await db.$disconnect();
  });

  it('persists — a reconnect does not fall back to "delete"', async () => {
    // The property the whole design leans on. journal_mode is written to the file header, so one
    // call covers every connection Prisma opens afterwards. Were it per-connection, configuring it
    // once at boot would tune a single pool member and leave the rest blocking.
    const dir = newDir(), file = join(dir, 'n.db');
    const first = await seeded(file);
    await configureSqlite(first);
    await first.$disconnect();

    const second = openAt(file);
    expect(await journalMode(second)).toBe('wal');
    await second.$disconnect();
  });

  it('is seen by a second, independent client', async () => {
    // A different process — a CLI, a backup job — must not open the same file in a different mode.
    const dir = newDir(), file = join(dir, 'n.db');
    const a = await seeded(file);
    await configureSqlite(a);

    const b = openAt(file);
    expect(await journalMode(b)).toBe('wal');
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it('is safe to call again on a database already in WAL', async () => {
    // It runs on every boot, and the second boot is the common case.
    const db = await seeded(join(newDir(), 'n.db'));
    await configureSqlite(db);
    const again = await configureSqlite(db);

    expect(again.wal).toBe(true);
    expect(again.journalMode).toBe('wal');
    await db.$disconnect();
  });

  it('does not lose data already in the file', async () => {
    const db = await seeded(join(newDir(), 'n.db'));
    await db.$executeRawUnsafe(`INSERT INTO t (v) VALUES ('before')`);
    await configureSqlite(db);

    const rows = await db.$queryRawUnsafe<{ v: string }[]>('SELECT v FROM t');
    expect(rows.map((r) => r.v)).toEqual(['before']);
    await db.$disconnect();
  });
});

describe('configureSqlite when WAL is refused', () => {
  it('reports the mode it actually got, and does not claim WAL', async () => {
    // SQLite answers a refused `journal_mode = WAL` by returning the mode still in force rather than
    // raising — so a caller that issued the pragma and moved on would believe it had concurrency it
    // does not have. This is the case that only shows up on someone's NFS mount, in production.
    const r = await configureSqlite(fakeClient(() => [{ journal_mode: 'delete' }]));

    expect(r.wal).toBe(false);
    expect(r.journalMode).toBe('delete');
    expect(r.warning).toBeTruthy();
  });

  it('names the cause an operator can act on', async () => {
    const r = await configureSqlite(fakeClient(() => [{ journal_mode: 'delete' }]));
    expect(r.warning).toMatch(/network|NFS|SMB/i);
    expect(r.warning).toMatch(/local disk/i);
  });

  it('never throws, because a gateway that cannot be tuned is degraded and not broken', async () => {
    const r = await configureSqlite(fakeClient(() => { throw new Error('disk I/O error'); }));

    expect(r.wal).toBe(false);
    expect(r.journalMode).toBeNull();
    expect(r.warning).toMatch(/disk I\/O error/);
  });

  it('treats an empty answer as "not WAL" rather than assuming success', async () => {
    const r = await configureSqlite(fakeClient(() => []));
    expect(r.wal).toBe(false);
    expect(r.journalMode).toBeNull();
    expect(r.warning).toBeTruthy();
  });
});

describe('closing a WAL database', () => {
  it('folds the log back in and cleans up its sidecars, with no checkpoint of ours', async () => {
    // This is the test that DELETED code. A checkpointSqlite() ran on shutdown until this measured
    // what a plain $disconnect already does — see the note in lib/sqlitePragma.ts. It stays as a
    // test because the deletion is only safe while this holds: if a future Prisma or SQLite stopped
    // checkpointing on close, a stopped gateway would start leaving its -wal behind and the reason
    // would be invisible.
    const dir = newDir(), file = join(dir, 'n.db');
    const db = await seeded(file);
    await configureSqlite(db);

    for (let i = 0; i < 200; i++) await db.$executeRawUnsafe(`INSERT INTO t (v) VALUES ('row-${i}')`);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    await db.$disconnect();
    await new Promise((r) => setTimeout(r, 300));   // the close is not instantaneous on Windows

    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);

    // And the rows are in the database itself, not lost with the sidecar.
    const reopened = openAt(file);
    const n = await reopened.$queryRawUnsafe<{ n: bigint }[]>('SELECT COUNT(*) AS n FROM t');
    expect(Number(n[0].n)).toBe(200);
    await reopened.$disconnect();
  });
});
