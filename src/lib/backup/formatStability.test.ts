/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Can this build still open a backup an older build wrote? (Phase B1.2b)
//
// Every other test here writes a file and reads it back with the same code, which proves the two
// halves agree with each other and nothing at all about whether either still agrees with the files
// already sitting on somebody's disk. A format is a promise made to the past, and the only way to
// keep it is to keep a file from the past and open it.
//
// src/lib/backup/__fixtures__/v1-backup.nxb is committed for exactly that. It is regenerated only
// when the format version is deliberately raised — and then the old fixture STAYS, so both versions
// keep being proven. Never regenerate it to make this file pass: the failure IS the finding.
//
// This matters more the longer the product lives. Today a break costs nothing, because nothing is
// released. After the first operator has a year of nightly backups, a silent format change is
// data loss discovered at the worst possible moment.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { CIPHER, TAG_BYTES, parseHeader, unwrapFileKey, BACKUP_VERSION } from './format';
import { decodeRow } from './rowCodec';

/** Must match scripts/backup/makeFixture.ts. */
const PASSPHRASE = 'the-fixture-passphrase-v1';
const FIXTURE = resolve(__dirname, '__fixtures__', 'v1-backup.nxb');

const file = readFileSync(FIXTURE);

/** Open the fixture exactly as a restore does, without needing a database. */
async function open(passphrase: string): Promise<string[]> {
  const nl = file.indexOf(0x0a);
  const headerLine = file.subarray(0, nl).toString('utf8');
  const header = parseHeader(headerLine);
  const body = file.subarray(nl + 1);

  const d = createDecipheriv(CIPHER, await unwrapFileKey(header, { passphrase }), Buffer.from(header.cipher.iv, 'hex'));
  d.setAAD(Buffer.from(headerLine, 'utf8'));
  d.setAuthTag(body.subarray(body.length - TAG_BYTES));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()]).toString('utf8');
  return plain.split('\n').filter(Boolean);
}

describe('a backup written by an earlier build still opens', () => {
  it('parses the committed header', () => {
    const header = parseHeader(file.subarray(0, file.indexOf(0x0a)).toString('utf8'));
    expect(header.version).toBe(BACKUP_VERSION);
    expect(header.recipients.some((r) => r.type === 'passphrase')).toBe(true);
  });

  it('decrypts with the passphrase it was written with', async () => {
    // If this fails, the envelope changed: the KDF, the wrapping, the AAD, or the layout. Any of
    // those makes every existing backup unreadable.
    const lines = await open(PASSPHRASE);
    expect(lines.length).toBeGreaterThan(2);
  });

  it('still reads as a manifest, rows and a trailer', async () => {
    const lines = await open(PASSPHRASE);
    const manifest = JSON.parse(lines[0]);
    const trailer = JSON.parse(lines[lines.length - 1]);

    expect(manifest.kind).toBe('manifest');
    expect(manifest.gatewayVersion).toBe('fixture');
    expect(trailer.kind).toBe('trailer');
    expect(trailer.totalRows).toBe(3);
  });

  it('still decodes the rows, with their types intact', async () => {
    // Guards rowCodec as much as the envelope: a change to the date tagging would silently turn
    // every timestamp in every existing backup into a string.
    const rows = (await open(PASSPHRASE)).map(decodeRow).filter((r) => r.model);

    expect(rows).toHaveLength(3);
    const provider = rows.find((r) => r.model === 'nexusProvider')!;
    expect(provider.slug).toBe('fixture');
    expect(provider.createdAt).toBeInstanceOf(Date);
    expect((provider.createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');

    expect(rows.find((r) => r.model === 'appSettings')!.value).toBe('{"kept":true}');
  });

  it('refuses the wrong passphrase, so the fixture is really encrypted', async () => {
    await expect(open('not-the-fixture-passphrase')).rejects.toThrow();
  });

  it('carries no gateway recipient, which is what makes it reproducible', () => {
    // A gateway recipient would be wrapped with whatever MASTER_ENCRYPTION_KEY happened to be set
    // when the fixture was generated, so it would open on one machine and not another — a test that
    // fails for a reason unrelated to the format.
    const header = parseHeader(file.subarray(0, file.indexOf(0x0a)).toString('utf8'));
    expect(header.recipients.every((r) => r.type === 'passphrase')).toBe(true);
  });
});
