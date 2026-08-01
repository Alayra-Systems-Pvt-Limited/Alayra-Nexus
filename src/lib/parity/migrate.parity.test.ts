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

describe.skipIf(!enabled)('moving to PostgreSQL, against a real one', { timeout: PARITY_TIMEOUT * 4 }, () => {
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

  it('never puts the credential in what it reports', async () => {
    const seen = await inspectTarget(url);
    expect(JSON.stringify(seen)).not.toContain(new URL(url).password);
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

  it('still reports the database as unoccupied when it has a schema but no rows', async () => {
    // The state after a failed first attempt. Refusing this would leave the operator stuck with no
    // way forward but dropping the database they just created.
    const seen = await inspectTarget(url);
    expect(seen.reachable).toBe(true);
    expect(seen.occupied).toEqual([]);
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
