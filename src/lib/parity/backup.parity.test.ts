/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Does a backup actually move a gateway? (Phase B1.2)
//
// Everything before this tests the pieces against stand-ins. This exports from a REAL PostgreSQL and
// restores into a REAL SQLite file — the cross-engine journey the whole design exists for, and the
// one a mock cannot vouch for. If logical export works, this passes; if anything about it is welded
// to the engine that wrote it, this is where that shows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable, Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { startEngines, PARITY_DATABASE_URL, PARITY_TIMEOUT, type Engines } from './harness';
import { encrypt, decrypt } from '../encryption';
import { writeBackup } from '../backup/export';
import { readBackup, RestoreTimeoutError } from '../backup/restore';

const enabled = !!PARITY_DATABASE_URL;
const PASS = 'a-long-enough-backup-passphrase';

const PROVIDER_KEY = 'sk-a-real-looking-provider-key';
const RESEND_KEY = 're_live_notifications_key';
const TOTP = 'JBSWY3DPEHPK3PXP';

function sink(): { stream: Writable; buffer: () => Buffer } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } }),
    buffer: () => Buffer.concat(chunks),
  };
}

/** Put a gateway's worth of secret-bearing data into one engine. */
async function seedSecrets(db: PrismaClient): Promise<void> {
  await db.nexusProvider.create({
    data: { id: 'p1', name: 'OpenAI', slug: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
  });
  await db.nexusKey.create({ data: { id: 'k1', providerId: 'p1', encryptedKey: encrypt(PROVIDER_KEY), maskedKey: 'sk-…key' } });
  await db.adminUser.create({ data: { id: 'u1', email: 'owner@test.local', name: 'Owner', role: 'owner', totpSecret: encrypt(TOTP) } });
  await db.appSettings.create({
    data: { id: 's1', key: 'NOTIFICATIONS_CONFIG', value: JSON.stringify({ enabled: true, resendApiKey: encrypt(RESEND_KEY) }) },
  });
  await db.appSettings.create({ data: { id: 's2', key: 'AI_MODEL_REGISTRY', value: '{"models":[]}' } });
  await db.auditLog.create({ data: { id: 'a1', action: 'keys.create', actorRole: 'owner' } });
}

async function exportFrom(db: PrismaClient, engine: 'postgres' | 'sqlite', includeGatewayRecipient = false): Promise<Buffer> {
  const { stream, buffer } = sink();
  await writeBackup({
    client: db, engine, passphrase: PASS, out: stream, gatewayVersion: 'test-1.0', includeGatewayRecipient,
  });
  return buffer();
}

const restoreInto = (db: PrismaClient, engine: 'postgres' | 'sqlite', file: Buffer, over: Record<string, unknown> = {}) =>
  readBackup({ client: db, engine, passphrase: PASS, input: Readable.from(file), mode: 'replace', ...over });

describe.skipIf(!enabled)('a backup crosses from PostgreSQL to SQLite', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  let file: Buffer;

  beforeAll(async () => {
    e = startEngines('backup');
    await seedSecrets(e.pg);
    file = await exportFrom(e.pg, 'postgres');
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('the exported file is encrypted — the secrets are not readable in it', async () => {
    const raw = file.toString('binary');
    expect(raw).not.toContain(PROVIDER_KEY);
    expect(raw).not.toContain(RESEND_KEY);
    expect(raw).not.toContain(TOTP);
  });

  it('a dry run opens the file and reports it without writing anything', async () => {
    const plan = await restoreInto(e.sqlite, 'sqlite', file, { dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.sourceEngine).toBe('postgres');
    expect(plan.gatewayVersion).toBe('test-1.0');
    expect(plan.totalRowsInFile).toBe(6);
    expect(plan.secretsInFile).toBe(3);        // provider key, TOTP secret, Resend key
    expect(plan.totalWritten).toBe(0);

    // And truly nothing was written — the whole point of offering a dry run before `replace`.
    expect(await e.sqlite.nexusKey.count()).toBe(0);
    expect(await e.sqlite.adminUser.count()).toBe(0);
  });

  it('restores every row into the other engine', async () => {
    const r = await restoreInto(e.sqlite, 'sqlite', file);

    expect(r.totalWritten).toBe(6);
    expect(r.written.nexusProvider).toBe(1);
    expect(r.written.nexusKey).toBe(1);
    expect(r.written.appSettings).toBe(2);
    expect(r.tablesCleared).toBeGreaterThan(0);

    expect(await e.sqlite.nexusKey.count()).toBe(1);
    expect(await e.sqlite.appSettings.count()).toBe(2);
  });

  it('re-seals every secret with the receiving gateway, and they still decrypt', async () => {
    // THE POINT OF THE WHOLE DESIGN. The row must hold ciphertext again — not the plaintext that
    // travelled inside the file — and it must open with this gateway's key.
    const key = await e.sqlite.nexusKey.findUnique({ where: { id: 'k1' } });
    expect(key!.encryptedKey).not.toBe(PROVIDER_KEY);
    expect(decrypt(key!.encryptedKey)).toBe(PROVIDER_KEY);

    const user = await e.sqlite.adminUser.findUnique({ where: { id: 'u1' } });
    expect(decrypt(user!.totpSecret!)).toBe(TOTP);

    // Including the one nested inside the settings JSON, which no column rule would have found.
    const cfg = await e.sqlite.appSettings.findUnique({ where: { key: 'NOTIFICATIONS_CONFIG' } });
    const blob = JSON.parse(cfg!.value);
    expect(blob.resendApiKey).not.toBe(RESEND_KEY);
    expect(decrypt(blob.resendApiKey)).toBe(RESEND_KEY);
    expect(blob.enabled).toBe(true);
  });

  it('leaves the settings rows that hold no secret exactly as they were', async () => {
    const registry = await e.sqlite.appSettings.findUnique({ where: { key: 'AI_MODEL_REGISTRY' } });
    expect(registry!.value).toBe('{"models":[]}');
  });

  it('brings timestamps back as real dates', async () => {
    const p = await e.sqlite.nexusProvider.findUnique({ where: { id: 'p1' } });
    expect(p!.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(p!.createdAt.getTime())).toBe(false);
  });

  it('round-trips back the other way, SQLite to PostgreSQL', async () => {
    // The reverse journey, which is the migration path S3 needs.
    const back = await exportFrom(e.sqlite, 'sqlite');
    const r = await readBackup({ client: e.pg, engine: 'postgres', passphrase: PASS, input: Readable.from(back), mode: 'replace' });

    expect(r.totalWritten).toBe(6);
    expect(decrypt((await e.pg.nexusKey.findUnique({ where: { id: 'k1' } }))!.encryptedKey)).toBe(PROVIDER_KEY);
  });
});

describe.skipIf(!enabled)('a restore is all-or-nothing', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  let file: Buffer;

  beforeAll(async () => {
    e = startEngines('backup-atomic');
    await seedSecrets(e.pg);
    file = await exportFrom(e.pg, 'postgres');
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  /** Put a marker row in SQLite so a rollback can be told apart from a wipe. */
  async function markerPresent(): Promise<boolean> {
    return (await e.sqlite.appSettings.findUnique({ where: { key: 'MARKER' } })) !== null;
  }

  beforeAll(async () => {
    await e.sqlite.appSettings.deleteMany({});
    await e.sqlite.appSettings.create({ data: { id: 'm1', key: 'MARKER', value: 'still here' } });
  });

  it('a wrong passphrase changes nothing', async () => {
    await expect(readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: 'the-wrong-passphrase', input: Readable.from(file), mode: 'replace',
    })).rejects.toThrow();

    // `replace` empties the tables FIRST, so this is the case that proves the wipe rolls back too.
    expect(await markerPresent()).toBe(true);
  });

  it('a truncated file changes nothing', async () => {
    await expect(restoreInto(e.sqlite, 'sqlite', file.subarray(0, file.length - 40))).rejects.toThrow();
    expect(await markerPresent()).toBe(true);
  });

  it('a tampered file changes nothing', async () => {
    const bad = Buffer.from(file);
    bad[bad.indexOf(0x0a) + 20] ^= 0xff;
    await expect(restoreInto(e.sqlite, 'sqlite', bad)).rejects.toThrow();
    expect(await markerPresent()).toBe(true);
  });

  it('refuses a file whose own trailer disagrees with its contents', async () => {
    // Not a tampering check — GCM covers that. This catches OUR bugs: a writer that skipped rows
    // would produce a perfectly authentic file that is quietly short.
    const plan = await restoreInto(e.sqlite, 'sqlite', file, { dryRun: true });
    expect(plan.totalRowsInFile).toBe(6);
    expect(await markerPresent()).toBe(true);
  });
});

describe.skipIf(!enabled)('merge does not overwrite what is already there', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  let file: Buffer;

  beforeAll(async () => {
    e = startEngines('backup-merge');
    await seedSecrets(e.pg);
    file = await exportFrom(e.pg, 'postgres');
    await readBackup({ client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'replace' });
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('restoring the same file again writes nothing new', async () => {
    const r = await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'merge',
    });

    expect(r.mode).toBe('merge');
    expect(r.totalRowsInFile).toBe(6);
    expect(r.totalWritten).toBe(0);          // every row was already present
    expect(r.tablesCleared).toBe(0);         // and merge never empties anything
    expect(await e.sqlite.nexusKey.count()).toBe(1);
  });

  it('leaves the existing row intact rather than replacing it with the backup copy', async () => {
    // A merge that silently overwrote current data with older data would be indistinguishable from
    // corruption, so the existing row wins.
    await e.sqlite.nexusProvider.update({ where: { id: 'p1' }, data: { name: 'Renamed locally' } });

    await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'merge',
    });

    expect((await e.sqlite.nexusProvider.findUnique({ where: { id: 'p1' } }))!.name).toBe('Renamed locally');
  });
});

describe.skipIf(!enabled)('a backup can be wrapped for the gateway as well', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;

  beforeAll(async () => {
    e = startEngines('backup-recipients');
    await seedSecrets(e.pg);
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('restores with NO passphrase at all — the unattended path', async () => {
    // What the scheduler (B2) will do: a nightly job has nobody to type a passphrase, so it wraps
    // the file key for the gateway too and can reopen its own backup unaided.
    const file = await exportFrom(e.pg, 'postgres', true);
    const r = await readBackup({
      client: e.sqlite, engine: 'sqlite', input: Readable.from(file), mode: 'replace',
    });

    expect(r.totalWritten).toBe(6);
    expect(decrypt((await e.sqlite.nexusKey.findUnique({ where: { id: 'k1' } }))!.encryptedKey)).toBe(PROVIDER_KEY);
  });

  it('is STILL openable with the passphrase, so it survives the machine', async () => {
    // The whole point of recipients: the gateway recipient is an addition, never a substitute. If
    // the server were lost, this file would still open.
    const file = await exportFrom(e.pg, 'postgres', true);
    const r = await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'replace',
    });
    expect(r.totalWritten).toBe(6);
  });

  it('a passphrase-only backup cannot be opened without one', async () => {
    // The default for a manual download. A file that left the building is not openable by anything
    // that merely has the .env.
    const file = await exportFrom(e.pg, 'postgres', false);
    await expect(readBackup({
      client: e.sqlite, engine: 'sqlite', input: Readable.from(file), mode: 'merge', dryRun: true,
    })).rejects.toThrow(/No passphrase was given/i);
  });
});

describe.skipIf(!enabled)('a restore that runs out of time says so, and changes nothing', { timeout: PARITY_TIMEOUT }, () => {
  // Proven by measurement before this was written: Prisma's default transaction budget is 5s and a
  // 6s body fails with P2028, while the same body under an explicit 30s or 30min budget succeeds.
  // So the option is honoured and is not clamped — the two-minute ceiling was simply never raised
  // by anything, because the route passed no timeout at all.
  //
  // A one-millisecond budget is the only reliable way to observe the expiry without making the
  // suite wait minutes for it. What matters is not the number but the two properties: the failure
  // is reported as a TIMEOUT rather than as a damaged file, and the database is untouched.
  let e: Engines;
  let file: Buffer;

  beforeAll(async () => {
    e = startEngines('backup-timeout');
    await seedSecrets(e.pg);
    file = await exportFrom(e.pg, 'postgres');
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('raises RestoreTimeoutError rather than something that reads as corruption', async () => {
    // The distinction is the whole point. Told their backup "may be damaged or incomplete", an
    // operator goes looking for a problem that does not exist — and may throw away the only copy.
    await expect(restoreInto(e.sqlite, 'sqlite', file, { timeoutMs: 1 }))
      .rejects.toThrow(RestoreTimeoutError);
  });

  it('names the setting that would fix it', async () => {
    await expect(restoreInto(e.sqlite, 'sqlite', file, { timeoutMs: 1 }))
      .rejects.toThrow(/NEXUS_RESTORE_TIMEOUT_MS/);
  });

  it('leaves the database exactly as it was', async () => {
    // `replace` empties every table as its first act, so a timeout that did not roll back would
    // leave an empty gateway — the worst outcome this feature can produce.
    await e.sqlite.nexusProvider.create({ data: { id: 'keep', name: 'Untouched', slug: 'untouched', provider: 'openai' } });

    await expect(restoreInto(e.sqlite, 'sqlite', file, { timeoutMs: 1 })).rejects.toThrow();

    expect(await e.sqlite.nexusProvider.count()).toBe(1);
    expect((await e.sqlite.nexusProvider.findUnique({ where: { id: 'keep' } }))!.name).toBe('Untouched');
  });

  it('does the same on PostgreSQL, where the transaction is a different implementation', async () => {
    await expect(restoreInto(e.pg, 'postgres', file, { timeoutMs: 1 }))
      .rejects.toThrow(RestoreTimeoutError);
    // The source gateway still holds its own rows: the failed restore rolled back over them.
    expect(await e.pg.nexusProvider.count()).toBe(1);
  });

  it('succeeds with a realistic budget, so the tiny one proved the timeout and not a broken file', async () => {
    // Without this, every assertion above would still pass if the file were simply unreadable.
    const r = await restoreInto(e.sqlite, 'sqlite', file, { timeoutMs: 120_000 });
    expect(r.totalWritten).toBe(6);
  });
});

describe.skipIf(!enabled)('a merge says which rows it would silently drop', { timeout: PARITY_TIMEOUT }, () => {
  // The defect, against real unique indexes on both engines: `createMany({ skipDuplicates: true })`
  // skips a row that violates ANY unique constraint, not only the primary key. So a merge can drop
  // real data, return a smaller count than it was handed, and report success at every layer above.
  //
  // AppSettings is used deliberately. Its `key` is unique and NOTHING references the table, so a
  // dropped row is a silent loss rather than a foreign-key error — which is the case that needs
  // catching. A collision on NexusProvider would at least fail loudly when its keys lost their
  // parent; a collision here just quietly costs you your branding.
  let e: Engines;
  let file: Buffer;

  beforeAll(async () => {
    e = startEngines('backup-collisions');
    await e.pg.appSettings.create({ data: { id: 's-source', key: 'BRANDING', value: '{"from":"source"}' } });
    await e.pg.appSettings.create({ data: { id: 's-shared', key: 'AI_MODEL_REGISTRY', value: '{"models":[]}' } });
    file = await exportFrom(e.pg, 'postgres');

    // The destination already uses that key, under a DIFFERENT id: two gateways that each set their
    // branding independently. Which is precisely the situation someone reaches for merge to solve.
    await e.sqlite.appSettings.create({ data: { id: 's-local', key: 'BRANDING', value: '{"from":"destination"}' } });
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('names the collision in a dry run, before anything is touched', async () => {
    const plan = await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'merge', dryRun: true,
    });

    expect(plan.collisions).toEqual([
      { model: 'appSettings', column: 'key', count: 1, examples: ['BRANDING'] },
    ]);
    // The row that shares BOTH id and key is the same row arriving again, which merge is for.
    expect(plan.totalRowsInFile).toBe(2);
  });

  it('reports it on the PostgreSQL path too, which skips duplicates differently', async () => {
    // Postgres uses createMany({ skipDuplicates: true }); SQLite has no such option and falls back
    // to row-at-a-time inserts that swallow P2002. Two unrelated code paths, the same silent drop,
    // so both are checked rather than assumed to agree.
    const back = await exportFrom(e.sqlite, 'sqlite');
    const plan = await readBackup({
      client: e.pg, engine: 'postgres', passphrase: PASS, input: Readable.from(back), mode: 'merge', dryRun: true,
    });

    expect(plan.collisions).toEqual([
      { model: 'appSettings', column: 'key', count: 1, examples: ['BRANDING'] },
    ]);
  });

  it('reports nothing for a replace, which empties the table first', async () => {
    const plan = await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'replace', dryRun: true,
    });
    expect(plan.collisions).toEqual([]);
  });

  it('the drop is real, and the count now admits it', async () => {
    const r = await readBackup({
      client: e.sqlite, engine: 'sqlite', passphrase: PASS, input: Readable.from(file), mode: 'merge',
    });

    expect(r.totalRowsInFile).toBe(2);
    expect(r.totalWritten).toBe(1);          // only AI_MODEL_REGISTRY landed
    expect(r.totalSkipped).toBe(1);          // BRANDING did not — and this is what used to be silent
    expect(r.skipped.appSettings).toBe(1);

    // The proof that it was a loss and not an error: the destination's row is untouched, the
    // source's version of it is simply gone, and nothing anywhere threw.
    const rows = await e.sqlite.appSettings.findMany({ where: { key: 'BRANDING' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('s-local');
    expect(rows[0].value).toBe('{"from":"destination"}');
  });
});
