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

import { encodeRow, decodeRow } from './rowCodec';

const round = (row: Record<string, unknown>) => decodeRow(encodeRow(row));

describe('encodeRow / decodeRow', () => {
  it('round-trips the ordinary scalars', () => {
    const row = { id: 'k1', name: 'Premium pool', active: true, priority: 3, cost: 1.25, note: null };
    expect(round(row)).toEqual(row);
  });

  it('brings a Date back as a Date, not a string', () => {
    // Prisma rejects a string where it expects a DateTime, so this is the difference between a
    // restore that works and one that fails on every row of all 24 timestamp columns.
    const createdAt = new Date('2026-03-01T12:34:56.789Z');
    const out = round({ id: 'x', createdAt });

    expect(out.createdAt).toBeInstanceOf(Date);
    expect((out.createdAt as Date).toISOString()).toBe(createdAt.toISOString());
  });

  it('keeps a string that merely LOOKS like a date as a string', () => {
    // THE TRAP. Date.toJSON() runs before any replacer, so a naive implementation cannot tell these
    // two apart and a "looks like a date" reviver silently converts real text into Date objects.
    const out = round({ realDate: new Date('2026-03-01T00:00:00.000Z'), text: '2026-03-01T00:00:00.000Z' });

    expect(out.realDate).toBeInstanceOf(Date);
    expect(out.text).toBe('2026-03-01T00:00:00.000Z');
    expect(typeof out.text).toBe('string');
  });

  it('preserves null timestamps, which most nullable columns are', () => {
    const out = round({ id: 'u1', totpConfirmedAt: null, lastLoginAt: null });
    expect(out.totpConfirmedAt).toBeNull();
    expect(out.lastLoginAt).toBeNull();
  });

  it('handles a BigInt instead of throwing mid-export', () => {
    // JSON.stringify THROWS on a BigInt rather than skipping it, which would abort an export with
    // an error naming neither the table nor the row.
    const out = round({ id: 'x', n: 9007199254740993n });
    expect(out.n).toBe(9007199254740993n);
  });

  it('survives a whole realistic row', () => {
    const row = {
      id: 'tk-1', name: 'Engineering', encryptedKey: 'iv:tag:cipher', keyHash: 'abc123',
      maskedKey: 'nx-…-9f2c', teamId: null, rpmLimit: 600, active: true,
      createdAt: new Date('2026-03-01T00:00:00.000Z'), lastUsedAt: null,
    };
    expect(round(row)).toEqual(row);
  });

  it('produces exactly one line, so JSONL framing cannot break', () => {
    // A newline inside a row would split it across two lines and desynchronise the whole file.
    const line = encodeRow({ note: 'first\nsecond\r\nthird', tab: 'a\tb' });
    expect(line).not.toMatch(/[\n\r]/);
    expect(decodeRow(line).note).toBe('first\nsecond\r\nthird');
  });

  it('handles unicode and quotes without mangling them', () => {
    const row = { name: 'Équipe "Alpha" — 日本語 🔑', q: 'he said \\"hi\\"' };
    expect(round(row)).toEqual(row);
  });

  it('round-trips nested objects and arrays, as the settings blobs are', () => {
    const row = { key: 'NOTIFICATIONS_CONFIG', value: { to: ['a@b.c', 'd@e.f'], events: { keyBanned: true } } };
    expect(round(row)).toEqual(row);
  });
});

describe('decodeRow refuses what it cannot trust', () => {
  it('rejects a line that is not an object', () => {
    expect(() => decodeRow('"a string"')).toThrow(/not a row object/i);
    expect(() => decodeRow('[1,2,3]')).toThrow(/not a row object/i);
    expect(() => decodeRow('null')).toThrow(/not a row object/i);
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeRow('{oops')).toThrow();
  });

  it('rejects a date tag that is not a date, rather than yielding Invalid Date', () => {
    // An Invalid Date would be written to the database as null or throw deep inside Prisma; better
    // to fail here, naming the value.
    expect(() => decodeRow('{"createdAt":{"$d":"not-a-date"}}')).toThrow(/unreadable date/i);
  });

  it('leaves an object that merely resembles a tag alone when it has other keys', () => {
    const out = decodeRow('{"v":{"$d":"2026-01-01T00:00:00.000Z","other":1}}');
    expect(out.v).toEqual({ $d: '2026-01-01T00:00:00.000Z', other: 1 });
  });
});

describe('binary columns (C2)', () => {
  // Defensive: no Bytes column exists in this schema today. It is here because adding a tag costs
  // an hour now and is a format change once backup files exist in the world -- and because the
  // failure without it is the worst kind: export SUCCEEDS and restore fails, so an operator learns
  // their backups were unusable at the moment they needed one.
  it('round-trips a Buffer as a Buffer', () => {
    const row = round({ id: 'k1', blob: Buffer.from([0x00, 0xff, 0x10, 0x7f]) });
    expect(Buffer.isBuffer(row.blob)).toBe(true);
    expect((row.blob as Buffer).equals(Buffer.from([0x00, 0xff, 0x10, 0x7f]))).toBe(true);
  });

  it('does not fall back to Buffer own toJSON', () => {
    // Untagged, JSON.stringify calls Buffer.toJSON and writes {"type":"Buffer","data":[0,255,...]} --
    // roughly twice the size of the bytes it describes, and JSON.parse hands that back as a plain
    // object that Prisma will not accept.
    const line = encodeRow({ blob: Buffer.from([1, 2, 3]) });
    expect(line).not.toContain('"type"');
    expect(line).not.toContain('"data"');
    expect(JSON.parse(line).blob).toEqual({ $b: 'AQID' });
  });

  it('handles a Uint8Array, which has no toJSON at all', () => {
    // A different wrong answer to the same question: untagged it serialises as {"0":1,"1":2,...}.
    const row = round({ blob: new Uint8Array([1, 2, 3]) });
    expect(Buffer.isBuffer(row.blob)).toBe(true);
    expect((row.blob as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('survives bytes that are not valid text', () => {
    const raw = Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0x00, 0xfe]);   // invalid UTF-8 on purpose
    expect((round({ blob: raw }).blob as Buffer).equals(raw)).toBe(true);
  });

  it('round-trips an empty buffer as an empty buffer, not as null', () => {
    const row = round({ blob: Buffer.alloc(0) });
    expect(Buffer.isBuffer(row.blob)).toBe(true);
    expect((row.blob as Buffer).length).toBe(0);
  });

  it('leaves a string that merely looks like a tag alone', () => {
    // The same trap the date tagging avoids: a column genuinely holding that text must come back as
    // that text, not as bytes.
    expect(round({ note: '{"$b":"AQID"}' }).note).toBe('{"$b":"AQID"}');
  });

  it('stays out of the way of a row with no binary in it', () => {
    expect(encodeRow({ id: 'x', n: 1, s: 'y' })).toBe('{"id":"x","n":1,"s":"y"}');
  });
});
