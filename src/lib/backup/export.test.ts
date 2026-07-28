/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createDecipheriv } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { encrypt } from '../encryption';
import { writeBackup } from './export';
import { MODEL_ORDER } from './modelOrder';
import { CIPHER, TAG_BYTES, parseHeader, unwrapFileKey } from './format';
import { decodeRow } from './rowCodec';

const PASS = 'a-long-enough-backup-passphrase';

// ── A Prisma stand-in ─────────────────────────────────────────────────────────────────────────
//
// Emulates cursor paging exactly as Prisma does — `cursor` names a row and `skip: 1` steps past it —
// because the paging loop is where an export silently drops or duplicates rows, and a fake that
// ignored the cursor would let that bug through.

type Rows = Record<string, Record<string, unknown>[]>;

function fakeClient(data: Rows): { client: PrismaClient; calls: number } {
  const state = { calls: 0 };
  const client: Record<string, unknown> = {};

  for (const model of MODEL_ORDER) {
    const rows = [...(data[model] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    client[model] = {
      findMany(args: { take: number; cursor?: { id: string }; skip?: number }) {
        state.calls++;
        let start = 0;
        if (args.cursor) start = rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0);
        return Promise.resolve(rows.slice(start, start + args.take).map((r) => ({ ...r })));
      },
    };
  }
  return { client: client as unknown as PrismaClient, calls: state.calls };
}

/** Collect everything written, so the produced file can be inspected. */
function sink(): { stream: Writable; buffer: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  return { stream, buffer: () => Buffer.concat(chunks) };
}

/** Open a produced file — the reader B1.2 will formalise, here just enough to assert on. */
async function open(file: Buffer, passphrase = PASS): Promise<{ header: unknown; lines: string[] }> {
  const nl = file.indexOf(0x0a);
  const headerLine = file.subarray(0, nl).toString('utf8');
  const header = parseHeader(headerLine);
  const body = file.subarray(nl + 1);

  const decipher = createDecipheriv(CIPHER, await unwrapFileKey(header, { passphrase }), Buffer.from(header.cipher.iv, 'hex'));
  decipher.setAAD(Buffer.from(headerLine, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));

  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  return { header, lines: plain.split('\n').filter(Boolean) };
}

async function run(data: Rows, over: Partial<Parameters<typeof writeBackup>[0]> = {}) {
  const { stream, buffer } = sink();
  const { client } = fakeClient(data);
  const summary = await writeBackup({
    client, engine: 'sqlite', passphrase: PASS, out: stream, gatewayVersion: '1.3.2', ...over,
  });
  return { summary, file: buffer() };
}

describe('writeBackup produces a readable, encrypted document', () => {
  it('writes a plaintext header, then ciphertext, then the tag', async () => {
    const { file } = await run({ team: [{ id: 't1', name: 'Eng' }] });

    const nl = file.indexOf(0x0a);
    expect(nl).toBeGreaterThan(0);
    expect(() => parseHeader(file.subarray(0, nl).toString('utf8'))).not.toThrow();
    // Nothing after the header should be readable.
    expect(file.subarray(nl + 1).toString('utf8')).not.toContain('Eng');
  });

  it('opens with the passphrase and holds a manifest, the rows, and a trailer', async () => {
    const { lines } = (await open((await run({ team: [{ id: 't1', name: 'Eng' }] })).file));

    const manifest = JSON.parse(lines[0]);
    expect(manifest.kind).toBe('manifest');
    expect(manifest.gatewayVersion).toBe('1.3.2');
    expect(manifest.engine).toBe('sqlite');
    expect(manifest.models).toEqual([...MODEL_ORDER]);

    const trailer = JSON.parse(lines[lines.length - 1]);
    expect(trailer.kind).toBe('trailer');
    expect(trailer.totalRows).toBe(1);
  });

  it('refuses to start without a usable passphrase', async () => {
    await expect(run({}, { passphrase: 'short' })).rejects.toThrow(/at least 12 characters/i);
    await expect(run({}, { passphrase: '' })).rejects.toThrow(/Enter a backup passphrase/i);
  });

  it('fails loudly if the client has no such model', async () => {
    const { stream } = sink();
    await expect(writeBackup({
      client: {} as PrismaClient, engine: 'postgres', passphrase: PASS, out: stream, gatewayVersion: '1',
    })).rejects.toThrow(/out of step with the schema/i);
  });
});

describe('every row is written exactly once', () => {
  it('pages through a table larger than the page size', async () => {
    // The bug this exists for: a cursor off-by-one that drops the first row of every page, or
    // repeats the last. Both produce a backup that looks fine and restores wrong.
    const rows = Array.from({ length: 47 }, (_, i) => ({ id: `u${String(i).padStart(3, '0')}`, email: `u${i}@x.test` }));
    const { summary, file } = await run({ adminUser: rows }, { pageSize: 10 });

    expect(summary.rowsByModel.adminUser).toBe(47);

    const written = (await open(file)).lines
      .map((l) => JSON.parse(l))
      .filter((r) => r.model === 'adminUser')
      .map((r) => r.id);

    expect(written).toHaveLength(47);
    expect(new Set(written).size).toBe(47);                       // no duplicates
    expect(written.sort()).toEqual(rows.map((r) => r.id).sort()); // and none missing
  });

  it('handles a table whose size is an exact multiple of the page size', async () => {
    // The classic edge: the final full page is followed by an empty one, and a loop that breaks on
    // `length < pageSize` must not stop one page early.
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `k${String(i).padStart(2, '0')}` }));
    const { summary } = await run({ nexusKey: rows }, { pageSize: 10 });
    expect(summary.rowsByModel.nexusKey).toBe(20);
  });

  it('handles empty tables and a completely empty gateway', async () => {
    const { summary, file } = await run({});
    expect(summary.totalRows).toBe(0);
    expect(summary.secrets).toBe(0);
    for (const m of MODEL_ORDER) expect(summary.rowsByModel[m]).toBe(0);

    // Still a valid, openable document — an empty gateway must still produce a real backup.
    const { lines } = await open(file);
    expect(JSON.parse(lines[0]).kind).toBe('manifest');
    expect(JSON.parse(lines[1]).kind).toBe('trailer');
  });

  it('writes models parents-first, in the declared order', async () => {
    const { file } = await run({
      tokenUsage: [{ id: 'tu1', sessionId: 's' }],
      team: [{ id: 't1' }],
      nexusTeamKey: [{ id: 'tk1' }],
    });

    const order = (await open(file)).lines
      .map((l) => JSON.parse(l)).filter((r) => r.model)
      .map((r) => r.model);

    expect(order.indexOf('team')).toBeLessThan(order.indexOf('nexusTeamKey'));
    expect(order.indexOf('nexusTeamKey')).toBeLessThan(order.indexOf('tokenUsage'));
  });
});

describe('secrets are taken out from under the master key', () => {
  it('stores the plaintext secret inside the encrypted file', async () => {
    // The point of the whole design: the file does not carry this gateway's ciphertext, so a
    // different gateway can re-seal it with its own key.
    const { summary, file } = await run({
      nexusKey: [{ id: 'k1', encryptedKey: encrypt('sk-the-real-provider-key'), providerId: 'p1' }],
    });

    expect(summary.secrets).toBe(1);
    const row = (await open(file)).lines.map((l) => JSON.parse(l)).find((r) => r.model === 'nexusKey');
    expect(row.encryptedKey).toBe('sk-the-real-provider-key');
  });

  it('reaches the key nested in the notifications settings blob', async () => {
    const { summary, file } = await run({
      appSettings: [
        { id: 's1', key: 'NOTIFICATIONS_CONFIG', value: JSON.stringify({ enabled: true, resendApiKey: encrypt('re_live_x') }) },
        { id: 's2', key: 'AI_MODEL_REGISTRY', value: '{"models":[]}' },
      ],
    });

    expect(summary.secrets).toBe(1);      // the registry row carries none
    const rows = (await open(file)).lines.map((l) => JSON.parse(l)).filter((r) => r.model === 'appSettings');
    expect(JSON.parse(rows.find((r) => r.key === 'NOTIFICATIONS_CONFIG').value).resendApiKey).toBe('re_live_x');
    expect(rows.find((r) => r.key === 'AI_MODEL_REGISTRY').value).toBe('{"models":[]}');
  });

  it('leaves hashes exactly as they are', async () => {
    const { file } = await run({
      nexusTeamKey: [{ id: 'tk1', encryptedKey: encrypt('nx-team'), keyHash: 'a-sha256-digest' }],
    });
    const row = (await open(file)).lines.map((l) => JSON.parse(l)).find((r) => r.model === 'nexusTeamKey');

    expect(row.keyHash).toBe('a-sha256-digest');
    expect(row.encryptedKey).toBe('nx-team');
  });

  it('counts the secrets it really wrote', async () => {
    const { summary } = await run({
      nexusKey: [{ id: 'k1', encryptedKey: encrypt('a') }, { id: 'k2', encryptedKey: encrypt('b') }],
      adminUser: [{ id: 'u1', totpSecret: encrypt('c') }, { id: 'u2', totpSecret: null }],
    });
    expect(summary.secrets).toBe(3);
  });

  it('preserves dates as dates through the file', async () => {
    const createdAt = new Date('2026-03-01T12:00:00.000Z');
    const { file } = await run({ team: [{ id: 't1', name: 'Eng', createdAt }] });

    const line = (await open(file)).lines.find((l) => l.includes('"model":"team"'))!;
    expect(decodeRow(line).createdAt).toBeInstanceOf(Date);
    expect((decodeRow(line).createdAt as Date).toISOString()).toBe(createdAt.toISOString());
  });
});

describe('the file resists being opened or altered', () => {
  it('will not open with the wrong passphrase', async () => {
    const { file } = await run({ team: [{ id: 't1' }] });
    await expect(open(file, 'the-wrong-passphrase-entirely')).rejects.toThrow();
  });

  it('will not open if the ciphertext was altered', async () => {
    const { file } = await run({ team: [{ id: 't1', name: 'Eng' }] });
    const nl = file.indexOf(0x0a);
    file[nl + 5] ^= 0xff;
    await expect(open(file)).rejects.toThrow();
  });

  it('will not open if the header was altered', async () => {
    // The AAD binding: rewriting the KDF cost to make offline guessing cheap must break the file.
    const { file } = await run({ team: [{ id: 't1' }] });
    const nl = file.indexOf(0x0a);
    const header = JSON.parse(file.subarray(0, nl).toString('utf8'));
    const weakened = Buffer.from(JSON.stringify({ ...header, kdf: { ...header.kdf, N: 2 } }), 'utf8');

    await expect(open(Buffer.concat([weakened, Buffer.from('\n'), file.subarray(nl + 1)]))).rejects.toThrow();
  });

  it('will not open if the file was truncated', async () => {
    // A half-copied backup must fail loudly rather than restore a partial gateway.
    const { file } = await run({ adminUser: Array.from({ length: 30 }, (_, i) => ({ id: `u${i}` })) });
    await expect(open(file.subarray(0, file.length - 40))).rejects.toThrow();
  });
});

describe('the trailer proves the export finished', () => {
  it('reports counts that match the rows actually in the file', async () => {
    // Guards a paging bug that under-writes: the trailer is counted from what was written, so a
    // mismatch here means the count and the writing disagree.
    const { file, summary } = await run({
      adminUser: Array.from({ length: 25 }, (_, i) => ({ id: `u${String(i).padStart(2, '0')}` })),
      team: [{ id: 't1' }, { id: 't2' }],
    }, { pageSize: 7 });

    const { lines } = await open(file);
    const trailer = JSON.parse(lines[lines.length - 1]);
    const actual = lines.map((l) => JSON.parse(l)).filter((r) => r.model).length;

    expect(trailer.totalRows).toBe(actual);
    expect(trailer.totalRows).toBe(27);
    expect(trailer.rowsByModel.adminUser).toBe(25);
    expect(summary).toEqual({ rowsByModel: trailer.rowsByModel, totalRows: 27, secrets: 0 });
  });
});
