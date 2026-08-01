/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Moving to PostgreSQL, against a real PostgreSQL (Phase S3).
//
// Two claims in this feature cannot be checked without one, and both would fail in a way no unit
// test would notice:
//
//  1. That the Prisma CLI can be found and spawned from inside an installed package, and will build
//     the schema in a database the gateway has never seen. The whole feature rests on this, and a
//     comment elsewhere in this codebase asserted for months that it was impossible.
//  2. That `inspectTarget` can tell an empty database from one already holding somebody's gateway —
//     it reads `information_schema` before any of our tables exist, which is exactly the state no
//     mock reproduces faithfully.
//
// Skipped without PARITY_DATABASE_URL, like every parity suite. CI sets it; a developer machine
// without a Postgres does not, which is why these must never be the ONLY check on anything.

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PARITY_DATABASE_URL, PARITY_TIMEOUT, freshDatabase } from './harness';
import { migrateDeploy } from '../prismaCli';
import { inspectTarget } from '../../services/pgMigrate.service';
import { MODEL_ORDER } from '../backup/modelOrder';

const enabled = !!PARITY_DATABASE_URL;

// `shuffle: false` is load-bearing here for the same reason it is in reset.parity.test.ts: these
// are one narrative told in order — empty, then built, then built again, then filled. Shuffled, the
// test that inserts a row runs before the one asserting there are none, and the suite fails for a
// reason that has nothing to do with the code. `npm run test:hunt -- --shuffle-tests` turns
// shuffling on, which is how this was found.
describe.skipIf(!enabled)('moving to PostgreSQL, against a real one', { timeout: PARITY_TIMEOUT * 4, shuffle: false }, () => {
  let url = '';

  beforeAll(() => { url = freshDatabase('migrate'); });

  it('reports an empty database as reachable and unoccupied', async () => {
    // Before anything is created. `information_schema` answers on a database with no tables at all,
    // which is the state a customer's brand-new database is in and the one a mock gets wrong.
    const seen = await inspectTarget(url);

    expect(seen.problem).toBeNull();
    expect(seen.reachable).toBe(true);
    expect(seen.occupied).toEqual([]);
    expect(seen.version).toMatch(/postgresql/i);
  });

  it('never puts the credential in what it reports, even when the connection is refused', async () => {
    // A sentinel password rather than the real one. CI's Postgres password is literally "nexus",
    // which is also in the host and the database name — so asserting the real password is absent
    // fails against correct output, and would have to be deleted rather than fixed.
    //
    // The wrong password is the point as well as the workaround: authentication failure is the path
    // where a driver is most likely to quote the whole datasource back, so this exercises the leak
    // that matters instead of the one that cannot happen.
    const sentinel = 'zzsentinelpw9137';
    const wrong = new URL(url);
    wrong.password = sentinel;

    const seen = await inspectTarget(wrong.toString());

    expect(seen.reachable).toBe(false);
    expect(JSON.stringify(seen)).not.toContain(sentinel);
    expect(seen.problem).toBeTruthy();
  });

  it('builds the whole schema by spawning the Prisma CLI', async () => {
    // THE claim the feature rests on: `prisma` is a runtime dependency, the migrations ship, and the
    // CLI can be resolved and run from inside an installed package.
    const built = await migrateDeploy(url);
    expect(built.ok, built.output).toBe(true);

    const client = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
    try {
      const tables = await client.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `;
      const names = new Set(tables.map((t) => t.table_name));

      // Every model, not "some" — a migration that built most of the schema would leave a gateway
      // that starts and then fails on whichever table shipped most recently. That exact bug is what
      // migration 0017 exists to fix.
      for (const model of MODEL_ORDER) {
        expect(names, `${model} is missing from the migrated schema`)
          .toContain(model.charAt(0).toUpperCase() + model.slice(1));
      }

      // And the history, which is the difference between a schema and one that can be upgraded.
      // Without this row a customer's next upgrade replays migration 0001 onto existing tables.
      const applied = await client.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
      `;
      expect(Number(applied[0].n)).toBeGreaterThan(0);
    } finally {
      await client.$disconnect();
    }
  });

  it('is safe to run twice, because a first attempt may have failed partway', async () => {
    const again = await migrateDeploy(url);
    expect(again.ok, again.output).toBe(true);
  });

  it('still reports the database as unoccupied when it has a schema but only seeded placeholders', async () => {
    // The state after a failed first attempt, and the state of EVERY database this feature builds:
    // migration 0001 seeds three placeholder rows into AppSettings so a fresh install has something
    // to replace. Counted as data they would make a retry impossible forever, against the schema
    // the previous attempt had just created.
    //
    // This is what found that. It cannot be reproduced without a real PostgreSQL, because the seed
    // lives in the migration rather than the schema.
    const client = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
    let seeded = 0;
    try {
      seeded = await client.appSettings.count();
    } finally {
      await client.$disconnect();
    }
    expect(seeded, 'migration 0001 is expected to seed placeholder settings').toBeGreaterThan(0);

    const seen = await inspectTarget(url);
    expect(seen.reachable).toBe(true);
    expect(seen.occupied).toEqual([]);
  });

  it('counts a real setting as data, even though the placeholders beside it are not', async () => {
    // The exclusion is by the placeholder MARKER, not by table — so AppSettings still protects a
    // real gateway. Had it been "ignore AppSettings", this would pass while the feature happily
    // overwrote somebody's live configuration.
    const client = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
    try {
      await client.appSettings.create({ data: { key: 'a-real-setting', value: 'a real value' } });
      const seen = await inspectTarget(url);
      expect(seen.occupied).toContain('AppSettings');
    } finally {
      await client.appSettings.deleteMany({ where: { key: 'a-real-setting' } });
      await client.$disconnect();
    }
  });

  it('refuses a database that already holds a gateway', async () => {
    const client = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
    try {
      await client.appSettings.create({ data: { key: 'someone-elses-gateway', value: 'yes' } });
    } finally {
      await client.$disconnect();
    }

    const seen = await inspectTarget(url);
    expect(seen.reachable).toBe(true);
    expect(seen.occupied).toContain('AppSettings');
  });

  it('says what is wrong rather than throwing, when the server is not there', async () => {
    // Port 1 is reserved and nothing listens on it. The migration path turns this into a sentence
    // an operator can act on; an exception here would surface as a 500 with no explanation.
    const seen = await inspectTarget('postgresql://nexus:nexus@127.0.0.1:1/nowhere');

    expect(seen.reachable).toBe(false);
    expect(seen.problem).toBeTruthy();
    expect(seen.problem).not.toMatch(/invocation/i);
    expect(seen.problem).not.toContain('nexus:nexus');
  });
});
