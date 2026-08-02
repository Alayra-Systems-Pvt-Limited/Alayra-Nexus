/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The one property that matters here: what goes in comes out, byte for byte.
//
// A backup that reassembles differently from how it was written is the worst failure this module
// can have. It has the right name, the right size, and it fails to authenticate at the moment
// somebody needs it — which is the only moment anybody would find out.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

interface Row { id: string; filename: string; createdAt: Date; bytes: number; rows: number; origin: string }
interface Chunk { backupId: string; seq: number; data: Buffer }

const { db } = vi.hoisted(() => ({ db: { backups: [] as Row[], chunks: [] as Chunk[], nextId: 1 } }));

vi.mock('../prisma', () => ({
  prisma: {
    backup: {
      create: async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        const row: Row = { ...data, id: `b${db.nextId++}`, createdAt: new Date(db.nextId * 1000) };
        db.backups.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = db.backups.find((b) => b.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      findMany: async () => [...db.backups].sort((a, b) => +b.createdAt - +a.createdAt),
      findUnique: async ({ where }: { where: { filename: string } }) =>
        db.backups.find((b) => b.filename === where.filename) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        db.backups = db.backups.filter((b) => b.id !== where.id);
        db.chunks = db.chunks.filter((c) => c.backupId !== where.id);
        return {};
      },
      deleteMany: async ({ where }: { where: { filename: string } }) => {
        const doomed = db.backups.filter((b) => b.filename === where.filename).map((b) => b.id);
        db.backups = db.backups.filter((b) => !doomed.includes(b.id));
        db.chunks = db.chunks.filter((c) => !doomed.includes(c.backupId));
        return { count: doomed.length };
      },
    },
    backupChunk: {
      create: async ({ data }: { data: Chunk }) => { db.chunks.push({ ...data }); return data; },
      findMany: async ({ where, take }: { where: { backupId: string; seq: { gt: number } }; take: number }) =>
        db.chunks
          .filter((c) => c.backupId === where.backupId && c.seq > where.seq.gt)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, take),
    },
  },
}));

import {
  beginStoredBackup, readStoredBackup, listStoredBackups, findStoredBackup, CHUNK_BYTES,
} from './backupStore';

const NAME = 'alayra-nexus-backup-2026-08-01-04-00-00.nxb';

const drain = async (backupId: string): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const piece of readStoredBackup(backupId)) parts.push(piece as Buffer);
  return Buffer.concat(parts);
};

/**
 * Compared by digest rather than by value.
 *
 * `toEqual` on a multi-megabyte Buffer walks it element by element and turns a millisecond
 * assertion into half a minute of CI. A sha256 over both sides says the same thing — these are the
 * same bytes in the same order — and says it in one pass.
 */
const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Write `payload` through the sink exactly as `writeBackup` would. */
async function store(payload: Buffer, name = NAME): Promise<{ id: string; bytes: number }> {
  const writer = await beginStoredBackup(name);
  await pipeline(Readable.from([payload]), writer.out, { end: false });
  writer.describeContents({ rows: 42 });
  const bytes = await writer.commit();
  const saved = await findStoredBackup(name);
  return { id: saved!.id, bytes };
}

beforeEach(() => { db.backups = []; db.chunks = []; db.nextId = 1; });

describe('a stored backup survives the round trip', () => {
  it('returns exactly the bytes it was given, when smaller than one chunk', async () => {
    const payload = randomBytes(2048);
    const { id, bytes } = await store(payload);

    expect(bytes).toBe(payload.length);
    expect(await drain(id)).toEqual(payload);
  });

  it('returns exactly the bytes it was given, across many chunks', async () => {
    // Deliberately not a multiple of CHUNK_BYTES: an off-by-one in the remainder flush would pass
    // on a clean multiple and corrupt every real backup, which are never clean multiples.
    const payload = randomBytes(CHUNK_BYTES * 3 + 12_345);
    const { id, bytes } = await store(payload);

    expect(bytes).toBe(payload.length);
    expect(digest(await drain(id))).toBe(digest(payload));
  });

  it('splits into whole chunks numbered from zero, with the remainder last', async () => {
    const payload = randomBytes(CHUNK_BYTES * 2 + 500);
    await store(payload);

    const seqs = db.chunks.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1, 2]);
    expect(db.chunks.find((c) => c.seq === 0)!.data.length).toBe(CHUNK_BYTES);
    expect(db.chunks.find((c) => c.seq === 1)!.data.length).toBe(CHUNK_BYTES);
    expect(db.chunks.find((c) => c.seq === 2)!.data.length).toBe(500);
  });

  it('reassembles by sequence number, not by the order rows come back', async () => {
    // The failure this guards: a database free to return rows in any order it likes produces a file
    // that is the right size, authenticates as garbage, and is only discovered during a restore.
    const payload = randomBytes(CHUNK_BYTES * 2 + 7);
    const { id } = await store(payload);

    db.chunks.reverse();
    expect(digest(await drain(id))).toBe(digest(payload));
  });
});

describe('a half-written backup is never mistaken for a real one', () => {
  it('is invisible in the list until commit', async () => {
    const writer = await beginStoredBackup(NAME);
    await pipeline(Readable.from([randomBytes(64)]), writer.out, { end: false });

    // The row exists — chunks need a parent to point at — but not under a backup name.
    expect(db.backups).toHaveLength(1);
    expect(await listStoredBackups()).toHaveLength(0);
    expect(await findStoredBackup(NAME)).toBeNull();

    writer.describeContents({ rows: 1 });
    await writer.commit();
    expect(await listStoredBackups()).toHaveLength(1);
  });

  it('leaves nothing behind when aborted', async () => {
    const writer = await beginStoredBackup(NAME);
    await pipeline(Readable.from([randomBytes(CHUNK_BYTES + 10)]), writer.out, { end: false });
    await writer.abort();

    expect(db.backups).toHaveLength(0);
    expect(db.chunks).toHaveLength(0);
  });

  it('clears a partial left by an earlier crash under the same name', async () => {
    // Without this the unique constraint on `filename` rejects the retry, and one interrupted
    // backup blocks that name until somebody deletes the row by hand.
    const crashed = await beginStoredBackup(NAME);
    await pipeline(Readable.from([randomBytes(32)]), crashed.out, { end: false });
    expect(db.backups).toHaveLength(1);

    const { id } = await store(randomBytes(128));
    expect(db.backups).toHaveLength(1);
    expect(db.chunks.every((c) => c.backupId === id)).toBe(true);
  });

  it('refuses a name a COMPLETED backup already holds, before writing anything', async () => {
    // A backup's name is its timestamp to the second, and two runs that finish inside the same
    // second ask for the same one — reachable by pressing "Back up now" twice, and hit by the e2e
    // suite doing exactly that.
    //
    // The refusal has to happen HERE. It used to surface at `commit`, after the whole database had
    // been exported and written into chunk rows: all of that work discarded, reported as a raw
    // "Unique constraint failed on the fields: (`filename`)", and the partial row left behind
    // holding every chunk — invisible to the archive and counting against storage forever.
    await store(randomBytes(64));
    expect(db.backups).toHaveLength(1);

    await expect(beginStoredBackup(NAME)).rejects.toThrow(/already exists/i);

    // Nothing was created for the attempt: no second parent, and no chunks belonging to one.
    expect(db.backups).toHaveLength(1);
    expect(db.backups[0].filename).toBe(NAME);
    expect(db.chunks.every((c) => c.backupId === db.backups[0].id)).toBe(true);
  });
});

describe('what the dashboard reads', () => {
  it('records the row count it was told, and the size it measured', async () => {
    const payload = randomBytes(4096);
    await store(payload);

    const saved = await findStoredBackup(NAME);
    expect(saved).toMatchObject({ rows: 42, bytes: payload.length, origin: 'scheduled' });
  });

  it('remembers whether a backup was taken by hand or by the schedule', async () => {
    const writer = await beginStoredBackup(NAME, 'manual');
    await pipeline(Readable.from([randomBytes(16)]), writer.out, { end: false });
    writer.describeContents({ rows: 1 });
    await writer.commit();

    expect(await findStoredBackup(NAME)).toMatchObject({ origin: 'manual' });
  });
});
