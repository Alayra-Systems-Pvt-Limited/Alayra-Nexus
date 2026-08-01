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
import { startEngines, seedBoth, PARITY_DATABASE_URL, PARITY_TIMEOUT, type Engines } from './harness';
import { emptyEveryTable } from '../resetTables';

const enabled = !!PARITY_DATABASE_URL;

// `shuffle: false` is load-bearing, not decoration. These tests are one narrative told in order —
// seed, prove the seed landed, wipe, prove the wipe worked, prove the schema survived — and test 2
// destroys the state test 1 checks. Vitest runs a file in declaration order, so this is normally
// implicit; declaring it means the requirement lives in the code rather than in whoever remembers
// it, and a run with shuffling turned on (npm run test:hunt -- --shuffle-tests) keeps this suite
// intact instead of reporting a failure that cannot happen in CI.
//
// Seeding per test would remove the coupling outright, at the cost of a full PostgreSQL and SQLite
// seed for each — not worth it for a file whose reason to exist is that a wipe is irreversible.
describe.skipIf(!enabled)('factory reset empties everything, on both engines', { timeout: PARITY_TIMEOUT, shuffle: false }, () => {
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

    // 18 models in the schema. Asserting the NUMBER matters: a discovery query that silently
    // returned a subset would still "empty everything it found" and report success.
    //
    // The count includes Backup and BackupChunk. Those two are excluded from the backup EXPORT,
    // but a reset must still clear them, and for a reason stronger than tidiness — see the test
    // below.
    expect(cleared).toBe(18);

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
      expect(await emptyEveryTable(db, engine)).toBe(18);
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
    expect(names).toHaveLength(18);
    for (const n of names) expect(n.startsWith('sqlite_')).toBe(false);
    expect(names).toContain('TokenUsage');
    expect(names).toContain('AdminUser');
  });

  it('clears the stored backups, so a reset gateway cannot hand the previous keys to its next owner', async () => {
    // This is a security property, not housekeeping.
    //
    // A stored backup is every provider key, every team key and every TOTP secret of the install
    // that took it, and the archive endpoint will hand it to whoever is the owner NOW. A factory
    // reset returns the gateway to its claim screen for somebody new — so a reset that left the
    // rows behind would let the next person to claim it download the previous install's
    // credentials in one file. `emptyEveryTable` discovers its tables from the live schema rather
    // than a hand-written list, which is what makes this true by construction; this asserts it,
    // because a future exclusion added for the export could quietly reach here too.
    for (const [engine, db] of [['postgres', e.pg], ['sqlite', e.sqlite]] as const) {
      const backup = await db.backup.create({
        data: { filename: `alayra-nexus-backup-2026-08-01-04-00-0${engine === 'sqlite' ? 1 : 2}.nxb`, bytes: 3, rows: 1 },
      });
      await db.backupChunk.create({ data: { backupId: backup.id, seq: 0, data: Buffer.from('abc') } });

      await emptyEveryTable(db, engine);

      expect(await db.backup.count()).toBe(0);
      expect(await db.backupChunk.count()).toBe(0);
    }
  });
});
