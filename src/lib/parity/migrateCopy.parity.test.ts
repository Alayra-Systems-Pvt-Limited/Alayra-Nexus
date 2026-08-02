/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The move itself: a populated SQLite gateway, a real PostgreSQL, and the data arriving.
//
// ── Why this file had to exist ────────────────────────────────────────────────────────────────
//
// `migrate.parity.test.ts` next door covers the first half — that the Prisma CLI can be spawned to
// build a schema, and that `inspectTarget` can tell an empty database from an occupied one. It
// stops exactly where the risk starts. `copyRows` and `migrateToPostgres` had no test at any level:
// not a unit test, not a parity test, not an e2e. The one operation in this codebase whose entire
// purpose is that every row survives was the one operation with no proof that any row did.
//
// That gap matters more here than almost anywhere else, because of HOW this fails. A migration that
// cannot connect fails loudly and nobody is hurt. A migration that copies 1,200 of 1,201 usage rows
// reports success, shows matching-looking totals on a screen, and the operator then changes
// DATABASE_URL and deletes nothing — the old gateway is still there, so they are safe — but they
// believe a number that is wrong, and they find out weeks later with no way to say which rows went.
// Cursor paging is precisely the loop that produces that: an off-by-one at a page boundary drops or
// repeats the row at the seam and nothing else changes.
//
// ── How the source gateway is supplied ────────────────────────────────────────────────────────
//
// `migrateToPostgres` reads `prisma` and `dbEngine` from lib/prisma, which resolves ONE client at
// import time from the environment. There is no seam to pass a source through, and adding one for
// the sake of a test would change production code to a shape production does not need. So the
// module is mocked, and what is put behind it is not a stub but a REAL SQLite client with the real
// schema pushed — the same client a standalone gateway runs on. Everything under test is genuine:
// two engines, the actual Prisma CLI, actual foreign keys.
//
// maintenance.service IS a stub, and deliberately: it belongs to Redis and has its own tests, and
// what this file needs from it is not its behaviour but a record of the CALLS — that the gateway was
// closed before the first row moved and opened again afterwards, including when the move refuses.
//
// Skipped without PARITY_DATABASE_URL, like every parity suite. CI sets it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PARITY_DATABASE_URL, PARITY_TIMEOUT, freshDatabase, startSqlite, type SqliteGateway } from './harness';
import { MODEL_ORDER } from '../backup/modelOrder';
import { seedGateway, SEEDED, SECRETS, REAL_SETTINGS, STORED_BACKUPS, USAGE_ROWS } from './migrateSeed';

// Hoisted so the mock factories below can reach it — they run before anything else in this file.
// `client` is filled in beforeAll, which is why both exports are getters: a snapshot taken when the
// factory ran would hand the service a null client.
const source = vi.hoisted(() => ({ engine: 'sqlite' as string, client: null as unknown }));

vi.mock('../prisma', () => ({
  get dbEngine() { return source.engine; },
  get prisma() { return source.client; },
}));

const maintenance = vi.hoisted(() => ({
  begin: [] as { reason: string; expected: number | undefined }[],
  progress: [] as number[],
  ended: 0,
}));

vi.mock('../../services/maintenance.service', () => ({
  beginMaintenance: vi.fn(async (reason: string, expected?: number) => {
    maintenance.begin.push({ reason, expected });
  }),
  // MUST return a promise: the service calls `void reportProgress(n).catch(…)`, so a stub returning
  // undefined would throw inside the copy loop rather than beside it.
  reportProgress: vi.fn(async (n: number) => { maintenance.progress.push(n); }),
  endMaintenance: vi.fn(async () => { maintenance.ended += 1; }),
}));

// Written below the mocks, which vitest hoists above every import regardless — the order is for the
// reader, so nobody is left wondering whether the service picked up the real lib/prisma.
import { migrateToPostgres, type MigrationOutcome } from '../../services/pgMigrate.service';

const enabled = !!PARITY_DATABASE_URL;

/** Every seeded row, which is what a complete move must report. */
const TOTAL = Object.values(SEEDED).reduce((sum, n) => sum + n, 0);

// `shuffle: false` for the same reason as migrate.parity.test.ts: this is one story told in order.
// The move happens once in beforeAll and the tests below read the gateway it produced; the refusal
// cases at the end depend on the target being full by then.
describe.skipIf(!enabled)('moving a gateway onto PostgreSQL, both engines real', { timeout: PARITY_TIMEOUT * 6, shuffle: false }, () => {
  let sqlite: SqliteGateway;
  let target: PrismaClient;
  let url = '';
  let outcome: MigrationOutcome;

  beforeAll(async () => {
    sqlite = startSqlite('migratecopy');
    source.client = sqlite.client;
    await seedGateway(sqlite.client);

    // Empty, with no schema — the state a customer's newly-created database is in. Building it is
    // part of what is under test, not a precondition set up on its behalf.
    url = freshDatabase('migratecopy');
    outcome = await migrateToPostgres(url);

    target = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  }, PARITY_TIMEOUT * 6);

  afterAll(async () => {
    await target?.$disconnect().catch(() => { /* nothing left to do about it */ });
    await sqlite?.dispose();
  });

  // ── The claim the whole feature makes ───────────────────────────────────────

  it('moves every row, and the counts it reports are the counts that are there', () => {
    // Named in the failure, because `expected true, got false` about a migration is useless.
    expect(outcome.ok, outcome.error ?? outcome.detail ?? '').toBe(true);
    expect(outcome.mismatches).toEqual([]);
    expect(outcome.rowsCopied).toBe(TOTAL);

    // Both sides, against a table written by hand. Comparing source to target alone would pass if
    // the export walked a short model list, since the same list is counted on both ends.
    expect(outcome.sourceCounts).toEqual(SEEDED);
    expect(outcome.targetCounts).toEqual(SEEDED);
  });

  it('has a seeded row for every model that travels, so no model is silently untested', () => {
    // Without this, adding a model to MODEL_ORDER leaves it with zero rows on both sides — which
    // MATCHES, and reports a successful migration of a table nothing ever checked.
    expect(Object.keys(SEEDED).sort()).toEqual([...MODEL_ORDER].sort());
  });

  it('carries a table larger than one page without losing or repeating a row at the seam', async () => {
    // `PAGE` is 500 and the seed writes 1,201, so the copy pages four times and ends short. The
    // boundary rows are the ones a cursor with `skip: 1` gets wrong.
    expect(await target.tokenUsage.count()).toBe(USAGE_ROWS);

    const ids = (await target.tokenUsage.findMany({ select: { id: true } })).map((r) => r.id);
    // A duplicated row would keep the count right on a table with no unique constraint beyond the
    // primary key only because the count and the distinct count are the same number — so check both.
    expect(new Set(ids).size).toBe(USAGE_ROWS);

    const seams = ['usage-00000', 'usage-00499', 'usage-00500', 'usage-00999', 'usage-01000', 'usage-01200'];
    expect(seams.filter((id) => ids.includes(id))).toEqual(seams);
  });

  // ── The reason rows are copied rather than exported and restored ────────────

  it('delivers every secret byte for byte', async () => {
    // Both ends share one master key, which is the entire premise: ciphertext travels untouched and
    // nothing has to be decrypted in flight. Any layer that re-encodes a string makes every
    // credential in the gateway unopenable, and a length or non-null check would not notice.
    const key = await target.nexusKey.findUniqueOrThrow({ where: { id: 'key-1' } });
    expect(key.encryptedKey).toBe(SECRETS.providerKey);

    const teamKey = await target.nexusTeamKey.findUniqueOrThrow({ where: { id: 'tk-1' } });
    expect(teamKey.encryptedKey).toBe(SECRETS.teamKey);

    const sso = await target.ssoProvider.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(sso.clientSecret).toBe(SECRETS.ssoSecret);

    const owner = await target.adminUser.findUniqueOrThrow({ where: { id: 'user-1' } });
    expect(owner.passwordHash).toBe(SECRETS.password);
    expect(owner.totpSecret).toBe(SECRETS.totpSecret);

    // Null is the enforcement for an SSO account, not a missing value. A copy that turned it into
    // an empty string would let that account attempt a local password.
    const ssoUser = await target.adminUser.findUniqueOrThrow({ where: { id: 'user-2' } });
    expect(ssoUser.passwordHash).toBeNull();
  });

  it('leaves the operator’s own settings in place of the ones the schema build seeded', async () => {
    // `migrate deploy` inserts three AppSettings rows so that a fresh install has something to
    // replace, and this gateway's real settings use the SAME KEYS. So `clearTarget` is not
    // housekeeping — without it the very first batch violates the unique index on `key` and the
    // migration dies having written part of a database. Verified by removing that call: seven tests
    // in this file go red, this one on the rows and the rest on a move that never finished.
    //
    // Telling a seeded placeholder from a real setting by key AND value is a different rule, on the
    // inspect path, and it is covered next door in migrate.parity.test.ts — the target here has no
    // tables at all when it is inspected, so nothing in this file exercises it.
    const rows = await target.appSettings.findMany({ orderBy: { key: 'asc' } });
    expect(rows.map((r) => ({ key: r.key, value: r.value })))
      .toEqual([...REAL_SETTINGS].sort((a, b) => a.key.localeCompare(b.key)));

    expect(rows.some((r) => r.value === 'REPLACE_ON_INIT' || r.value === '[]')).toBe(false);
  });

  it('writes parents before children, which is why the relations still resolve', async () => {
    // A foreign key would have refused the insert outright, so this is belt and braces — but it is
    // the assertion that says the data is USABLE rather than merely present.
    const usage = await target.tokenUsage.findUniqueOrThrow({
      where: { id: 'usage-00000' },
      include: { teamKey: { include: { team: true } } },
    });
    expect(usage.teamKey?.team?.name).toBe('Platform');

    const byok = await target.nexusKey.findUniqueOrThrow({
      where: { id: 'key-2' }, include: { ownerTeam: true, provider: true },
    });
    expect(byok.ownerTeam?.name).toBe('Platform');
    expect(byok.provider.name).toBe('Anthropic');

    // Deliberately unparented in the seed. A copy that "repaired" it would be inventing data.
    const orphan = await target.nexusTeamKey.findUniqueOrThrow({ where: { id: 'tk-3' } });
    expect(orphan.teamId).toBeNull();
  });

  // ── What is deliberately left behind ────────────────────────────────────────

  it('leaves stored backups behind, and names them in the report', async () => {
    expect(await target.backup.count()).toBe(0);
    expect(await target.backupChunk.count()).toBe(0);

    // Observed, not assumed: the source really did hold some, so their absence means they were
    // skipped rather than never existing.
    expect(await sqlite.client.backup.count()).toBe(STORED_BACKUPS.backup);
    expect(await sqlite.client.backupChunk.count()).toBe(STORED_BACKUPS.backupChunk);

    // And the operator is told, because a migration that silently dropped backup history would be
    // discovered at the worst possible moment.
    expect([...outcome.notMigrated]).toEqual(expect.arrayContaining(['backup', 'backupChunk']));
  });

  // ── The gateway's availability around the move ──────────────────────────────

  it('closes the gateway for the copy and opens it again afterwards', () => {
    // A copy is a snapshot taken over time; anything written to the source mid-copy would never
    // arrive. Raised once, with the row total so the screen can show progress against it.
    expect(maintenance.begin).toHaveLength(1);
    expect(maintenance.begin[0].expected).toBe(TOTAL);
    expect(maintenance.begin[0].reason).toContain('being moved to');

    // And lowered. A migration that finished behind a flag nobody dropped is an outage the operator
    // did not choose — worse than the failure that caused it.
    expect(maintenance.ended).toBe(1);

    // Progress only ever moves forward, and ends at the number the report gives.
    expect(maintenance.progress.length).toBeGreaterThan(1);
    expect([...maintenance.progress].sort((a, b) => a - b)).toEqual(maintenance.progress);
    expect(maintenance.progress[maintenance.progress.length - 1]).toBe(TOTAL);
  });

  // ── The refusals, on a target that is now full ──────────────────────────────

  it('refuses a database that already holds a gateway, and does not touch it', async () => {
    const before = await target.tokenUsage.count();
    const again = await migrateToPostgres(url);

    expect(again.ok).toBe(false);
    expect(again.error).toContain('already holds Nexus data');
    // The refusal names the tables, so the operator can see it is their own data and not a bug.
    expect(again.error).toContain('TokenUsage');

    // Nothing was written, nothing was cleared. `clearTarget` runs AFTER this check, and if the two
    // were ever reordered this migration would empty a live gateway before refusing to fill it.
    expect(await target.tokenUsage.count()).toBe(before);
    expect(await target.appSettings.count()).toBe(REAL_SETTINGS.length);

    // And it refused early enough that the gateway was never closed for it.
    expect(maintenance.begin).toHaveLength(1);
  });

  it('refuses when this gateway is already on PostgreSQL', async () => {
    source.engine = 'postgres';
    try {
      const wrong = await migrateToPostgres(url);
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('already running on PostgreSQL');
      // Never reached the target at all, so it cannot have disturbed it.
      expect(maintenance.begin).toHaveLength(1);
    } finally {
      source.engine = 'sqlite';
    }
  });
});
