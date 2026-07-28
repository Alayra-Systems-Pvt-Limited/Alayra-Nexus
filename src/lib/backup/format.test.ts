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
import { createCipheriv, createDecipheriv, generateKeyPairSync } from 'node:crypto';
import {
  BACKUP_FORMAT, BACKUP_VERSION, CIPHER, IV_BYTES, SALT_BYTES, TAG_BYTES, KEY_BYTES, MAX_RECIPIENTS,
  X25519_DER_BYTES, newFileKey, wrapForPassphrase, wrapForGateway, wrapForRecovery,
  unwrapWithRecovery, sealWithPassphrase, openWithPassphrase, buildHeader, headerBytes, parseHeader,
  unwrapFileKey, passphraseProblem, survivesTheMachine, type Recipient,
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

describe('every file must outlive the machine that wrote it', () => {
  // The rule widened in C6 rather than loosening: it was "a passphrase recipient is mandatory", and
  // is now "at least one recipient that survives the machine" — passphrase OR recovery. Both reduce
  // to something the operator knows; the gateway key reduces to something the server holds, which
  // is why it still cannot stand alone.
  it('refuses to build a gateway-only header', async () => {
    // A gateway-only backup is unopenable the moment the machine is gone — the exact disaster this
    // feature exists to prevent. This is the last point it can be stopped.
    expect(() => buildHeader([wrapForGateway(newFileKey())]))
      .toThrow(/openable by something other than this gateway/i);
  });

  it('refuses an empty recipient list', () => {
    expect(() => buildHeader([])).toThrow(/openable by something other than this gateway/i);
  });

  it('accepts a recovery recipient in place of a passphrase one', async () => {
    // What makes an unattended nightly backup possible without storing a passphrase anywhere: the
    // gateway wraps for the operator's public key, which it cannot itself open.
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const sealed = await sealWithPassphrase(privateKey.export({ format: 'der', type: 'pkcs8' }), PASS);

    expect(() => buildHeader([
      wrapForRecovery(newFileKey(), der, sealed),
      wrapForGateway(newFileKey()),
    ])).not.toThrow();
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

describe('the recovery recipient (C6)', () => {
  // The mailbox: the gateway keeps the slot and can drop backups in; only the operator's key opens
  // them. This is what lets a 3am backup be locked to something the server cannot open.
  /** An operator's recovery key as the gateway holds it: a public half and a sealed private half. */
  const recovery = async () => {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    return {
      privateKey,
      der: publicKey.export({ format: 'der', type: 'spki' }),
      sealed: await sealWithPassphrase(privateKey.export({ format: 'der', type: 'pkcs8' }), PASS),
    };
  };

  it('round-trips the file key through the operator key', async () => {
    const fileKey = newFileKey();
    const k = await recovery();
    const r = wrapForRecovery(fileKey, k.der, k.sealed);

    expect(unwrapWithRecovery(r, k.privateKey).equals(fileKey)).toBe(true);
  });

  it('wraps knowing ONLY the public half and an opaque sealed blob', async () => {
    // The whole point. Nothing the gateway can open is needed to lock a backup for the operator, so
    // nothing that opens a backup has to sit on the server waiting for 3am.
    const k = await recovery();
    expect(() => wrapForRecovery(newFileKey(), k.der, k.sealed)).not.toThrow();
  });

  it('OPENS ON A FRESH MACHINE WITH NOTHING BUT THE PASSPHRASE', async () => {
    // The case the whole feature exists for, and the one an earlier draft of this design got wrong.
    //
    // A nightly backup is wrapped for [gateway, recovery] — no passphrase recipient, because nobody
    // is awake to type one. The server then dies. If the recovery private key lived only in
    // AppSettings, it would now be sitting INSIDE the very file it is needed to open, and the
    // operator's passphrase would be worthless. Carrying the sealed key in the header is what makes
    // this test pass.
    const fileKey = newFileKey();
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(fileKey, k.der, k.sealed), wrapForGateway(fileKey)]);

    // A new machine: parse from bytes, no database, no stored key, gateway key explicitly refused.
    const parsed = parseHeader(headerBytes(h).toString('utf8'));
    const opened = await unwrapFileKey(parsed, { passphrase: PASS, allowGateway: false });

    expect(opened.equals(fileKey)).toBe(true);
  });

  it('refuses the wrong passphrase on that same path', async () => {
    const fileKey = newFileKey();
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(fileKey, k.der, k.sealed)]);

    await expect(unwrapFileKey(h, { passphrase: 'not-the-passphrase', allowGateway: false }))
      .rejects.toThrow();
  });

  it('cannot be opened by a different recovery key', async () => {
    const k = await recovery();
    const other = await recovery();
    const r = wrapForRecovery(newFileKey(), k.der, k.sealed);

    expect(() => unwrapWithRecovery(r, other.privateKey)).toThrow();
  });

  it('uses a fresh ephemeral key for every file', async () => {
    // Reuse would give two backups to the same operator the same wrapping key, so cracking one
    // would open every other.
    const k = await recovery();
    const a = wrapForRecovery(newFileKey(), k.der, k.sealed);
    const b = wrapForRecovery(newFileKey(), k.der, k.sealed);

    expect(a.epk).not.toBe(b.epk);
    expect(a.wrapped).not.toBe(b.wrapped);
  });

  it('wraps the same file key differently each time', async () => {
    const fileKey = newFileKey();
    const k = await recovery();
    expect(wrapForRecovery(fileKey, k.der, k.sealed).wrapped)
      .not.toBe(wrapForRecovery(fileKey, k.der, k.sealed).wrapped);
  });

  it('carries an ephemeral key of exactly the DER length', async () => {
    const k = await recovery();
    const r = wrapForRecovery(newFileKey(), k.der, k.sealed);
    expect(Buffer.from(r.epk, 'hex').length).toBe(X25519_DER_BYTES);
  });

  it('survives a header round trip', async () => {
    const fileKey = newFileKey();
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(fileKey, k.der, k.sealed)]);
    const parsed = parseHeader(headerBytes(h).toString('utf8'));

    expect((await unwrapFileKey(parsed, { recoveryKey: k.privateKey })).equals(fileKey)).toBe(true);
  });

  it('is refused when its ephemeral key is the wrong size', async () => {
    // createPublicKey on attacker-chosen bytes is a parser. A header does not get to decide how
    // much this process hands it.
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(newFileKey(), k.der, k.sealed)]);
    const raw = JSON.parse(headerBytes(h).toString('utf8'));
    raw.recipients[0].epk = 'aa'.repeat(200);

    expect(() => parseHeader(JSON.stringify(raw))).toThrow(/malformed header/i);
  });

  it('is refused when its sealed key names ruinous KDF parameters', async () => {
    // The same denial-of-service lever as a passphrase recipient, arriving through a second door.
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(newFileKey(), k.der, k.sealed)]);
    const raw = JSON.parse(headerBytes(h).toString('utf8'));
    raw.recipients[0].sealedPrivate.kdf.N = 2 ** 30;

    expect(() => parseHeader(JSON.stringify(raw))).toThrow(/more memory than is allowed/i);
  });

  it('is not opened by the gateway key, however tempting', async () => {
    const k = await recovery();
    const h = buildHeader([wrapForRecovery(newFileKey(), k.der, k.sealed)]);
    await expect(unwrapFileKey(h, { allowGateway: true })).rejects.toThrow();
  });

  it('counts as surviving the machine; the gateway recipient does not', async () => {
    const k = await recovery();
    expect(survivesTheMachine(wrapForRecovery(newFileKey(), k.der, k.sealed))).toBe(true);
    expect(survivesTheMachine(await wrapForPassphrase(newFileKey(), PASS))).toBe(true);
    expect(survivesTheMachine(wrapForGateway(newFileKey()))).toBe(false);
  });
});

describe('sealing the recovery private key with a passphrase', () => {
  const SECRET = Buffer.from('a private key, notionally', 'utf8');

  it('round-trips', async () => {
    const sealed = await sealWithPassphrase(SECRET, PASS);
    expect((await openWithPassphrase(sealed, PASS)).equals(SECRET)).toBe(true);
  });

  it('refuses the wrong passphrase rather than returning something', async () => {
    const sealed = await sealWithPassphrase(SECRET, PASS);
    await expect(openWithPassphrase(sealed, 'not-the-passphrase')).rejects.toThrow();
  });

  it('never stores the plaintext', async () => {
    const sealed = await sealWithPassphrase(SECRET, PASS);
    expect(JSON.stringify(sealed)).not.toContain(SECRET.toString('hex'));
    expect(JSON.stringify(sealed)).not.toContain('notionally');
  });

  it('uses a fresh salt each time, so two seals of one secret differ', async () => {
    const a = await sealWithPassphrase(SECRET, PASS);
    const b = await sealWithPassphrase(SECRET, PASS);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses key-derivation parameters that would exhaust memory', async () => {
    const sealed = await sealWithPassphrase(SECRET, PASS);
    sealed.kdf.N = 2 ** 30;
    await expect(openWithPassphrase(sealed, PASS)).rejects.toThrow(/invalid key-derivation/i);
  });

  it('refuses a blob sealed by something it does not understand', async () => {
    const sealed = await sealWithPassphrase(SECRET, PASS);
    (sealed.kdf as { name: string }).name = 'argon2';
    await expect(openWithPassphrase(sealed, PASS)).rejects.toThrow(/does not understand/i);
  });
});
