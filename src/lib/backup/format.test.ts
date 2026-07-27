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
  BACKUP_FORMAT, BACKUP_VERSION, CIPHER, IV_BYTES, SALT_BYTES, TAG_BYTES,
  newHeader, headerBytes, parseHeader, deriveKey, passphraseProblem,
} from './format';

describe('newHeader', () => {
  it('names the format and version it wrote', () => {
    const h = newHeader();
    expect(h.format).toBe(BACKUP_FORMAT);
    expect(h.version).toBe(BACKUP_VERSION);
    expect(h.cipher.name).toBe(CIPHER);
    expect(h.kdf.name).toBe('scrypt');
  });

  it('mints a fresh salt and IV every time', () => {
    // Reusing either across files is the classic way to make two backups attackable together.
    const a = newHeader(), b = newHeader();
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(Buffer.from(a.kdf.salt, 'hex')).toHaveLength(SALT_BYTES);
    expect(Buffer.from(a.cipher.iv, 'hex')).toHaveLength(IV_BYTES);
  });

  it('carries nothing about the gateway', () => {
    // The header is the only plaintext in the file. It must not tell a thief who this is, how big
    // the estate is, or when the backup was taken.
    const text = JSON.stringify(newHeader());
    for (const leak of ['createdAt', 'gateway', 'version"', 'rows', 'count', 'host', 'url']) {
      if (leak === 'version"') continue;   // format version is legitimately present
      expect(text).not.toContain(leak);
    }
    expect(Object.keys(newHeader()).sort()).toEqual(['cipher', 'format', 'kdf', 'version']);
  });
});

describe('parseHeader', () => {
  const round = (h: unknown) => parseHeader(JSON.stringify(h));

  it('accepts a header it wrote', () => {
    const h = newHeader();
    expect(round(h)).toEqual(h);
  });

  it('refuses something that is not a backup file at all', () => {
    expect(() => parseHeader('not json')).toThrow(/not an Alayra Nexus backup/i);
    expect(() => parseHeader('"a string"')).toThrow(/not an Alayra Nexus backup/i);
    expect(() => round({ format: 'something-else' })).toThrow(/not an Alayra Nexus backup/i);
  });

  it('refuses a newer format rather than reading part of it', () => {
    // Half-restoring a file written by a newer build would drop whatever fields this one does not
    // know about — silent partial data loss, which is worse than a clear refusal.
    expect(() => round({ ...newHeader(), version: 99 }))
      .toThrow(/format version 99.*reads version 1/i);
  });

  it('refuses an unknown cipher or KDF instead of guessing', () => {
    const h = newHeader();
    expect(() => round({ ...h, cipher: { ...h.cipher, name: 'aes-128-cbc' } })).toThrow(/Unsupported cipher/i);
    expect(() => round({ ...h, kdf: { ...h.kdf, name: 'pbkdf2' } })).toThrow(/Unsupported key derivation/i);
  });

  it('refuses a malformed salt or IV', () => {
    const h = newHeader();
    expect(() => round({ ...h, kdf: { ...h.kdf, salt: 'aa' } })).toThrow(/malformed salt/i);
    expect(() => round({ ...h, cipher: { ...h.cipher, iv: 'bb' } })).toThrow(/malformed initialisation/i);
  });

  it('refuses parameters that would allocate absurd memory', () => {
    // THE DENIAL-OF-SERVICE GUARD. These numbers come from a file somebody was sent. Handing them to
    // scrypt unchecked lets that file decide how much memory this process allocates.
    const h = newHeader();
    expect(() => round({ ...h, kdf: { ...h.kdf, N: 2 ** 30 } })).toThrow(/more memory than is allowed/i);
    expect(() => round({ ...h, kdf: { ...h.kdf, r: 100000 } })).toThrow(/more memory than is allowed/i);
  });

  it('refuses nonsense parameters that would make scrypt throw', () => {
    const h = newHeader();
    for (const kdf of [{ N: 0 }, { N: -1 }, { r: 0 }, { p: 0 }, { N: 1.5 }]) {
      expect(() => round({ ...h, kdf: { ...h.kdf, ...kdf } })).toThrow(/invalid key-derivation/i);
    }
  });

  it('refuses a header missing its parameters entirely', () => {
    expect(() => round({ format: BACKUP_FORMAT, version: BACKUP_VERSION }))
      .toThrow(/missing its encryption parameters/i);
  });
});

describe('deriveKey', () => {
  it('produces a 32-byte key', async () => {
    expect(await deriveKey('a-long-enough-passphrase', newHeader())).toHaveLength(32);
  });

  it('is deterministic for the same passphrase and salt', async () => {
    const h = newHeader();
    const a = await deriveKey('a-long-enough-passphrase', h);
    const b = await deriveKey('a-long-enough-passphrase', h);
    expect(a.equals(b)).toBe(true);
  });

  it('differs for a different passphrase, and for a different salt', async () => {
    const h = newHeader();
    const base = await deriveKey('a-long-enough-passphrase', h);
    expect((await deriveKey('a-different-passphrase', h)).equals(base)).toBe(false);
    expect((await deriveKey('a-long-enough-passphrase', newHeader())).equals(base)).toBe(false);
  });
});

describe('the envelope actually protects the file', () => {
  const PASS = 'a-long-enough-passphrase';
  const PLAIN = 'the secret contents of a gateway';

  /** Seal exactly as the exporter will: header as AAD, tag appended after the ciphertext. */
  async function seal(passphrase = PASS) {
    const header = newHeader();
    const aad = headerBytes(header);
    const cipher = createCipheriv(CIPHER, await deriveKey(passphrase, header), Buffer.from(header.cipher.iv, 'hex'));
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(PLAIN, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { header, aad, body };
  }

  async function open(headerLine: string, body: Buffer, passphrase = PASS): Promise<string> {
    const header = parseHeader(headerLine);
    const decipher = createDecipheriv(CIPHER, await deriveKey(passphrase, header), Buffer.from(header.cipher.iv, 'hex'));
    decipher.setAAD(Buffer.from(headerLine, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return decipher.update(body.subarray(0, body.length - TAG_BYTES)).toString('utf8') + decipher.final('utf8');
  }

  it('round-trips with the right passphrase', async () => {
    const { aad, body } = await seal();
    expect(await open(aad.toString('utf8'), body)).toBe(PLAIN);
  });

  it('a wrong passphrase fails outright — no separate verification step needed', async () => {
    // The reason the design has no stored key-hash to check against: GCM already refuses. A hash
    // would only give an attacker something to grind offline.
    const { aad, body } = await seal();
    await expect(open(aad.toString('utf8'), body, 'the-wrong-passphrase')).rejects.toThrow();
  });

  it('a tampered ciphertext fails', async () => {
    const { aad, body } = await seal();
    body[5] ^= 0xff;
    await expect(open(aad.toString('utf8'), body)).rejects.toThrow();
  });

  it('a tampered HEADER fails — this is what the AAD binding buys', async () => {
    // Without AAD, the KDF parameters would be the one part of the file an attacker could rewrite
    // freely: drop the scrypt cost, hand it back, and the victim opens it none the wiser.
    const { header, body } = await seal();
    const weakened = JSON.stringify({ ...header, kdf: { ...header.kdf, N: 2 } });
    await expect(open(weakened, body)).rejects.toThrow();
  });

  it('the tag is where the reader expects it', async () => {
    const { body } = await seal();
    expect(body.length).toBe(Buffer.byteLength(PLAIN) + TAG_BYTES);
  });
});

describe('passphraseProblem', () => {
  it('accepts a reasonable passphrase', () => {
    expect(passphraseProblem('correct horse battery staple')).toBeNull();
  });

  it('explains what the passphrase is for, since losing it is unrecoverable', () => {
    const msg = passphraseProblem('short')!;
    expect(msg).toMatch(/12 characters/);
    expect(msg).toMatch(/only way to open it again/i);
  });

  it('rejects empty and absurdly long', () => {
    expect(passphraseProblem('')).toMatch(/Enter a backup passphrase/i);
    expect(passphraseProblem('x'.repeat(300))).toMatch(/under 200/i);
  });
});
