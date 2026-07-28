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
import { createCipheriv, createDecipheriv } from 'node:crypto';
import {
  BACKUP_FORMAT, BACKUP_VERSION, CIPHER, IV_BYTES, SALT_BYTES, TAG_BYTES, KEY_BYTES, MAX_RECIPIENTS,
  newFileKey, wrapForPassphrase, wrapForGateway, buildHeader, headerBytes, parseHeader,
  unwrapFileKey, passphraseProblem, type Recipient,
} from './format';

const PASS = 'a-long-enough-passphrase';

async function header(over: { passphrase?: string; gateway?: boolean } = {}) {
  const fileKey = newFileKey();
  const recipients: Recipient[] = [await wrapForPassphrase(fileKey, over.passphrase ?? PASS)];
  if (over.gateway) recipients.push(wrapForGateway(fileKey));
  return { fileKey, header: buildHeader(recipients) };
}

describe('the file key', () => {
  it('is 32 bytes and different every time', () => {
    const a = newFileKey(), b = newFileKey();
    expect(a).toHaveLength(KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });

  it('is recovered exactly by the passphrase that wrapped it', async () => {
    const { fileKey, header: h } = await header();
    expect((await unwrapFileKey(h, { passphrase: PASS })).equals(fileKey)).toBe(true);
  });

  it('is recovered by this gateway when it is a recipient', async () => {
    // The unattended path: no passphrase supplied at all.
    const { fileKey, header: h } = await header({ gateway: true });
    expect((await unwrapFileKey(h, {})).equals(fileKey)).toBe(true);
  });

  it('is recovered by EITHER recipient — losing one does not lose the file', async () => {
    // The entire point of the design. Two independent losses are needed to lose a backup.
    const { fileKey, header: h } = await header({ gateway: true });
    expect((await unwrapFileKey(h, { passphrase: PASS })).equals(fileKey)).toBe(true);
    expect((await unwrapFileKey(h, { allowGateway: true })).equals(fileKey)).toBe(true);
  });

  it('is wrapped differently for each recipient, though it is the same key', async () => {
    const { header: h } = await header({ gateway: true });
    expect(h.recipients[0].wrapped).not.toBe(h.recipients[1].wrapped);
    expect(h.recipients[0].iv).not.toBe(h.recipients[1].iv);
  });

  it('refuses a wrong passphrase', async () => {
    const { header: h } = await header();
    await expect(unwrapFileKey(h, { passphrase: 'the-wrong-passphrase' })).rejects.toThrow(/could not be opened/i);
  });

  it('refuses when the gateway is not a recipient and no passphrase is given', async () => {
    const { header: h } = await header();
    await expect(unwrapFileKey(h, {})).rejects.toThrow(/No passphrase was given/i);
  });

  it('refuses when the gateway is explicitly disallowed', async () => {
    const { header: h } = await header({ gateway: true });
    await expect(unwrapFileKey(h, { allowGateway: false })).rejects.toThrow(/No passphrase was given/i);
  });

  it('says what it tried, without pretending to know why it failed', async () => {
    // A wrong passphrase, a foreign gateway and a corrupt wrap are genuinely indistinguishable here.
    const { header: h } = await header({ gateway: true });
    h.recipients[1].wrapped = 'ab'.repeat(KEY_BYTES);   // a wrap this gateway cannot open
    await expect(unwrapFileKey(h, { passphrase: 'wrong-one-entirely' }))
      .rejects.toThrow(/passphrase.*or.*gateway|gateway.*or.*passphrase/i);
  });
});

describe('a passphrase recipient is mandatory', () => {
  it('refuses to build a gateway-only header', async () => {
    // A gateway-only backup is unopenable the moment the machine is gone — the exact disaster this
    // feature exists to prevent. This is the last point it can be stopped.
    expect(() => buildHeader([wrapForGateway(newFileKey())]))
      .toThrow(/always be openable with a passphrase/i);
  });

  it('refuses an empty recipient list', () => {
    expect(() => buildHeader([])).toThrow(/always be openable with a passphrase/i);
  });

  it('accepts passphrase alone', async () => {
    const { header: h } = await header();
    expect(h.recipients).toHaveLength(1);
    expect(h.recipients[0].type).toBe('passphrase');
  });
});

describe('the header', () => {
  it('names the format and version, and carries nothing about the gateway', async () => {
    const { header: h } = await header({ gateway: true });
    expect(h.format).toBe(BACKUP_FORMAT);
    expect(h.version).toBe(BACKUP_VERSION);
    expect(Object.keys(h).sort()).toEqual(['cipher', 'format', 'recipients', 'version']);

    // `"type":"gateway"` is legitimately present — it names a recipient. What must NOT appear is
    // anything identifying the deployment or its size.
    const text = JSON.stringify(h);
    for (const leak of ['createdAt', 'gatewayVersion', 'rows', 'totalRows', 'host', 'http', 'engine']) {
      expect(text).not.toContain(leak);
    }
  });

  it('uses a fresh body IV and salt for every file', async () => {
    const a = await header(), b = await header();
    expect(a.header.cipher.iv).not.toBe(b.header.cipher.iv);
    expect((a.header.recipients[0] as { kdf: { salt: string } }).kdf.salt)
      .not.toBe((b.header.recipients[0] as { kdf: { salt: string } }).kdf.salt);
  });

  it('round-trips through parseHeader unchanged', async () => {
    const { header: h } = await header({ gateway: true });
    expect(parseHeader(JSON.stringify(h))).toEqual(h);
  });
});

describe('parseHeader refuses what it cannot trust', () => {
  const bad = (h: unknown) => () => parseHeader(JSON.stringify(h));

  it('rejects anything that is not a backup', () => {
    expect(() => parseHeader('not json')).toThrow(/not an Alayra Nexus backup/i);
    expect(bad({ format: 'something-else' })).toThrow(/not an Alayra Nexus backup/i);
  });

  it('rejects a newer format rather than reading part of it', async () => {
    const { header: h } = await header();
    expect(bad({ ...h, version: 99 })).toThrow(/format version 99.*reads version 1/i);
  });

  it('rejects a file with no recipients at all', async () => {
    const { header: h } = await header();
    expect(bad({ ...h, recipients: [] })).toThrow(/lists no way to open it/i);
  });

  it('rejects more recipients than allowed, BEFORE parsing them', async () => {
    // THE SECOND DENIAL-OF-SERVICE GUARD. Each passphrase recipient costs a deliberate ~100ms of
    // scrypt to try, so a file listing thousands would occupy the gateway for minutes on one upload.
    const { header: h } = await header();
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, () => h.recipients[0]);
    expect(bad({ ...h, recipients: many })).toThrow(new RegExp(`more than the ${MAX_RECIPIENTS} allowed`, 'i'));
  });

  it('accepts exactly the maximum', async () => {
    const { header: h } = await header();
    const max = Array.from({ length: MAX_RECIPIENTS }, () => h.recipients[0]);
    expect(() => parseHeader(JSON.stringify({ ...h, recipients: max }))).not.toThrow();
  });

  it('rejects key-derivation parameters that would allocate absurd memory', async () => {
    const { header: h } = await header();
    const r = h.recipients[0] as { kdf: Record<string, unknown> };
    expect(bad({ ...h, recipients: [{ ...r, kdf: { ...r.kdf, N: 2 ** 30 } }] })).toThrow(/more memory than is allowed/i);
    expect(bad({ ...h, recipients: [{ ...r, kdf: { ...r.kdf, r: 100000 } }] })).toThrow(/more memory than is allowed/i);
  });

  it('rejects nonsense derivation parameters', async () => {
    const { header: h } = await header();
    const r = h.recipients[0] as { kdf: Record<string, unknown> };
    for (const kdf of [{ N: 0 }, { N: -1 }, { r: 0 }, { p: 0 }, { N: 1.5 }]) {
      expect(bad({ ...h, recipients: [{ ...r, kdf: { ...r.kdf, ...kdf } }] })).toThrow(/invalid key-derivation/i);
    }
  });

  it('rejects an unknown recipient type rather than ignoring it', async () => {
    // Ignoring it would silently drop the only way somebody could open their file.
    const { header: h } = await header();
    expect(bad({ ...h, recipients: [{ ...h.recipients[0], type: 'kms' }] }))
      .toThrow(/recipient this gateway does not understand: "kms"/i);
  });

  it('rejects malformed sizes on any field', async () => {
    const { header: h } = await header();
    const r = h.recipients[0];
    expect(bad({ ...h, cipher: { name: CIPHER, iv: 'aa' } })).toThrow(/malformed header/i);
    expect(bad({ ...h, recipients: [{ ...r, iv: 'aa' }] })).toThrow(/malformed header/i);
    expect(bad({ ...h, recipients: [{ ...r, wrapped: 'aa' }] })).toThrow(/malformed header/i);
    expect(bad({ ...h, recipients: [{ ...r, tag: 'aa' }] })).toThrow(/malformed header/i);
  });

  it('rejects an unsupported cipher', async () => {
    const { header: h } = await header();
    expect(bad({ ...h, cipher: { ...h.cipher, name: 'aes-128-cbc' } })).toThrow(/Unsupported cipher/i);
  });
});

describe('the envelope protects the body', () => {
  const PLAIN = 'the secret contents of a gateway';

  async function seal(gateway = false) {
    const { fileKey, header: h } = await header({ gateway });
    const aad = headerBytes(h);
    const cipher = createCipheriv(CIPHER, fileKey, Buffer.from(h.cipher.iv, 'hex'));
    cipher.setAAD(aad);
    return { aad, body: Buffer.concat([cipher.update(PLAIN, 'utf8'), cipher.final(), cipher.getAuthTag()]) };
  }

  async function open(headerLine: string, body: Buffer, passphrase?: string): Promise<string> {
    const h = parseHeader(headerLine);
    const d = createDecipheriv(CIPHER, await unwrapFileKey(h, { passphrase }), Buffer.from(h.cipher.iv, 'hex'));
    d.setAAD(Buffer.from(headerLine, 'utf8'));
    d.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return d.update(body.subarray(0, body.length - TAG_BYTES)).toString('utf8') + d.final('utf8');
  }

  it('round-trips with the passphrase', async () => {
    const { aad, body } = await seal();
    expect(await open(aad.toString('utf8'), body, PASS)).toBe(PLAIN);
  });

  it('round-trips with the gateway key alone', async () => {
    const { aad, body } = await seal(true);
    expect(await open(aad.toString('utf8'), body)).toBe(PLAIN);
  });

  it('fails on a tampered body', async () => {
    const { aad, body } = await seal();
    body[3] ^= 0xff;
    await expect(open(aad.toString('utf8'), body, PASS)).rejects.toThrow();
  });

  it('fails when a recipient is STRIPPED from the header', async () => {
    // The header is AAD, so removing the gateway recipient to force a passphrase-only attack breaks
    // the body's authentication rather than quietly succeeding.
    const { aad, body } = await seal(true);
    const h = JSON.parse(aad.toString('utf8'));
    const stripped = JSON.stringify({ ...h, recipients: [h.recipients[0]] });
    await expect(open(stripped, body, PASS)).rejects.toThrow();
  });

  it('fails when the derivation cost is lowered in the header', async () => {
    // Rewriting N to 2 would make offline guessing trivial. AAD makes the file unreadable instead.
    const { aad, body } = await seal();
    const h = JSON.parse(aad.toString('utf8'));
    h.recipients[0].kdf.N = 2;
    await expect(open(JSON.stringify(h), body, PASS)).rejects.toThrow();
  });
});

describe('passphraseProblem', () => {
  it('accepts a reasonable passphrase', () => {
    expect(passphraseProblem('correct horse battery staple')).toBeNull();
  });

  it('explains what is at stake, since losing it is unrecoverable', () => {
    const msg = passphraseProblem('short')!;
    expect(msg).toMatch(/12 characters/);
    expect(msg).toMatch(/only way to open it again/i);
  });

  it('rejects empty and absurdly long', () => {
    expect(passphraseProblem('')).toMatch(/Enter a backup passphrase/i);
    expect(passphraseProblem('x'.repeat(300))).toMatch(/under 200/i);
  });
});

describe('sizes are what the readers assume', () => {
  it('holds the constants the streaming reader depends on', async () => {
    const { header: h } = await header({ gateway: true });
    expect(Buffer.from(h.cipher.iv, 'hex')).toHaveLength(IV_BYTES);
    for (const r of h.recipients) {
      expect(Buffer.from(r.iv, 'hex')).toHaveLength(IV_BYTES);
      expect(Buffer.from(r.tag, 'hex')).toHaveLength(TAG_BYTES);
      expect(Buffer.from(r.wrapped, 'hex')).toHaveLength(KEY_BYTES);
    }
    expect(Buffer.from((h.recipients[0] as { kdf: { salt: string } }).kdf.salt, 'hex')).toHaveLength(SALT_BYTES);
  });
});
