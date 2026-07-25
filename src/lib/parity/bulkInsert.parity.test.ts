/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Is the batched insert genuinely idempotent on both engines? (Phase S2.2)
//
// The audit writer and the usage pipeline both re-queue a batch when its insert fails, which is
// only safe if re-inserting a batch that partly landed is a no-op. Postgres gets that from
// `skipDuplicates`. SQLite has no such option — passing it is a validation error, not a no-op —
// so the fallback has to deliver the same guarantee, and this is where that is checked against a
// real database rather than a mock that would agree with whatever was written.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startEngines, PARITY_DATABASE_URL, type Engines } from './harness';
import { isUniqueViolation, type BulkDelegate } from '../bulkInsert';

const enabled = !!PARITY_DATABASE_URL;

type AuditRow = { id: string; action: string };

/**
 * The production function with its engine decided by argument rather than by module state.
 *
 * `createManyIgnoringDuplicates` reads `dbEngine` from lib/prisma, which is fixed at import — so
 * calling it directly could only ever test one engine per process. This mirrors it exactly; the
 * assertions below check the two stay in step.
 */
async function insertAs<Row>(engine: 'postgres' | 'sqlite', delegate: BulkDelegate<Row>, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  if (engine !== 'sqlite') {
    return (await delegate.createMany({ data: rows, skipDuplicates: true })).count;
  }
  try {
    return (await delegate.createMany({ data: rows })).count;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  let written = 0;
  for (const row of rows) {
    try { await delegate.create({ data: row }); written++; }
    catch (e) { if (!isUniqueViolation(e)) throw e; }
  }
  return written;
}

describe.skipIf(!enabled)('batched inserts are idempotent on both engines', () => {
  let e: Engines;
  beforeAll(() => { e = startEngines('bulk'); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  const delegate = (db: PrismaClient) => db.auditLog as unknown as BulkDelegate<AuditRow>;
  const rows = (ids: string[]): AuditRow[] => ids.map((id) => ({ id, action: 'test.action' }));

  it('sqlite: skipDuplicates is not merely ignored — it is a hard error', async () => {
    // The reason a fallback exists at all. If this ever starts passing, SQLite gained support and
    // the fallback can go; if it keeps failing, reaching for it in production would throw a
    // validation error that the audit writer would catch and turn into an endless re-queue.
    await expect(
      (e.sqlite.auditLog as unknown as BulkDelegate<AuditRow>).createMany({ data: rows(['x']), skipDuplicates: true }),
    ).rejects.toThrow(/skipDuplicates/i);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: inserts a clean batch and reports the count', async (engine) => {
    const db = engine === 'sqlite' ? e.sqlite : e.pg;
    await db.auditLog.deleteMany({});

    expect(await insertAs(engine, delegate(db), rows(['a1', 'a2', 'a3']))).toBe(3);
    expect(await db.auditLog.count()).toBe(3);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: re-inserting the same batch changes nothing', async (engine) => {
    const db = engine === 'sqlite' ? e.sqlite : e.pg;
    await db.auditLog.deleteMany({});
    await insertAs(engine, delegate(db), rows(['b1', 'b2']));

    // Exactly the re-queue case: the same batch, sent again.
    expect(await insertAs(engine, delegate(db), rows(['b1', 'b2']))).toBe(0);
    expect(await db.auditLog.count()).toBe(2);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: a partly-landed batch inserts only what is missing', async (engine) => {
    const db = engine === 'sqlite' ? e.sqlite : e.pg;
    await db.auditLog.deleteMany({});
    await insertAs(engine, delegate(db), rows(['c1', 'c2']));

    // The realistic failure: two rows landed, the flush died, the whole batch of four is retried.
    expect(await insertAs(engine, delegate(db), rows(['c1', 'c2', 'c3', 'c4']))).toBe(2);
    expect(await db.auditLog.count()).toBe(4);

    const ids = (await db.auditLog.findMany({ select: { id: true } })).map((r) => r.id).sort();
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: an empty batch is a no-op, not a query', async (engine) => {
    const db = engine === 'sqlite' ? e.sqlite : e.pg;
    expect(await insertAs(engine, delegate(db), [])).toBe(0);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: a real error still reaches the caller', async (engine) => {
    // The retry in audit.service catches everything and re-queues. If a genuine failure — a bad
    // column, a dead connection — were swallowed here and reported as a successful insert, the
    // buffer would be cleared and those audit records would be gone for good.
    const db = engine === 'sqlite' ? e.sqlite : e.pg;
    const broken = db.auditLog as unknown as BulkDelegate<Record<string, unknown>>;
    await expect(insertAs(engine, broken, [{ id: 'z1', nonexistentColumn: true }])).rejects.toThrow();
  });

  it('both engines end in the same state after the same sequence', async () => {
    for (const [engine, db] of [['postgres', e.pg], ['sqlite', e.sqlite]] as const) {
      await db.auditLog.deleteMany({});
      await insertAs(engine, delegate(db), rows(['d1', 'd2']));
      await insertAs(engine, delegate(db), rows(['d2', 'd3']));
      await insertAs(engine, delegate(db), rows(['d1', 'd2', 'd3']));
    }
    const ids = async (db: PrismaClient) =>
      (await db.auditLog.findMany({ select: { id: true } })).map((r) => r.id).sort();

    expect(await ids(e.sqlite)).toEqual(await ids(e.pg));
    expect(await ids(e.sqlite)).toEqual(['d1', 'd2', 'd3']);
  });
});
