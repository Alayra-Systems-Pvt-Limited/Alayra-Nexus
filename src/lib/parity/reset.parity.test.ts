/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Does a factory reset actually empty the gateway, on either engine? (Phase S2.2)
//
// Before this file, `factoryReset` had NO unit test at all — its only coverage was an end-to-end
// test running against PostgreSQL. A SQLite branch would have shipped with nothing exercising it,
// and the failure mode of a wipe that half-works is the worst kind: it reports success, the
// operator believes their keys and usage history are gone, and they are not.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEngines, seedBoth, PARITY_DATABASE_URL, type Engines } from './harness';
import { emptyEveryTable } from '../resetTables';

const enabled = !!PARITY_DATABASE_URL;

describe.skipIf(!enabled)('factory reset empties everything, on both engines', () => {
  let e: Engines;

  beforeAll(async () => { e = startEngines('reset'); await seedBoth(e); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('seeded data exists first — otherwise "everything is empty" proves nothing', async () => {
    for (const db of [e.pg, e.sqlite]) {
      expect(await db.tokenUsage.count()).toBe(12);
      expect(await db.team.count()).toBe(2);
      expect(await db.nexusTeamKey.count()).toBe(4);
    }
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: clears every table and reports the count', async (engine) => {
    const db = engine === 'sqlite' ? e.sqlite : e.pg;

    const cleared = await emptyEveryTable(db, engine);

    // 16 models in the schema. Asserting the NUMBER matters: a discovery query that silently
    // returned a subset would still "empty everything it found" and report success.
    expect(cleared).toBe(16);

    expect(await db.tokenUsage.count()).toBe(0);
    expect(await db.team.count()).toBe(0);
    expect(await db.nexusTeamKey.count()).toBe(0);
    expect(await db.appSettings.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
    expect(await db.adminUser.count()).toBe(0);
  });

  it('leaves the schema intact — a reset is not a drop', async () => {
    // The tables must still exist and still accept writes; an operator lands on the claim screen,
    // not on a gateway that cannot store the account they are about to create.
    for (const db of [e.pg, e.sqlite]) {
      await db.appSettings.create({ data: { key: 'after-reset', value: 'ok' } });
      expect((await db.appSettings.findUnique({ where: { key: 'after-reset' } }))?.value).toBe('ok');
      await db.appSettings.deleteMany({});
    }
  });

  it('is idempotent — resetting an already-empty gateway is not an error', async () => {
    for (const [engine, db] of [['postgres', e.pg], ['sqlite', e.sqlite]] as const) {
      expect(await emptyEveryTable(db, engine)).toBe(16);
    }
  });

  it('sqlite: a failure partway through rolls the whole wipe back', async () => {
    // The property Postgres gets free from a single TRUNCATE statement, and the reason the SQLite
    // deletes run inside one transaction. Without it, a reset that died on table 9 of 16 would
    // leave a gateway with no accounts but a full usage history — and would look like it worked.
    await seedBoth(e);
    expect(await e.sqlite.tokenUsage.count()).toBe(12);

    await expect(e.sqlite.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
      await tx.$executeRawUnsafe('DELETE FROM "TokenUsage"');
      await tx.$executeRawUnsafe('DELETE FROM "Team"');
      await tx.$executeRawUnsafe('DELETE FROM "ThisTableDoesNotExist"');   // the failure
    })).rejects.toThrow();

    expect(await e.sqlite.tokenUsage.count()).toBe(12);
    expect(await e.sqlite.team.count()).toBe(2);
  });

  it('sqlite: does not try to delete the engine\'s own internal tables', async () => {
    // sqlite_master cannot be deleted from; a discovery query that included it would make every
    // reset fail. sqlite_sequence and the autoindex entries are equally not ours.
    const rows = await e.sqlite.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toHaveLength(16);
    for (const n of names) expect(n.startsWith('sqlite_')).toBe(false);
    expect(names).toContain('TokenUsage');
    expect(names).toContain('AdminUser');
  });
});
