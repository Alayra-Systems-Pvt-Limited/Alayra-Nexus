/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { encrypt, decrypt, maskKey } from './encryption';

describe('encryption (AES-256-GCM)', () => {
  it('round-trips plaintext back to the original', () => {
    const secret = 'sk-ant-api03-0123456789abcdef';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const secret = 'same-plaintext';
    expect(encrypt(secret)).not.toBe(encrypt(secret));
  });

  it('emits the expected iv:authTag:ciphertext shape', () => {
    const parts = encrypt('anything').split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16-byte IV, hex
  });

  it('handles unicode and long strings', () => {
    const secret = '🔐 provider-key — ' + 'x'.repeat(500);
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('rejects ciphertext of the wrong format', () => {
    expect(() => decrypt('not-valid-ciphertext')).toThrow();
  });

  it('rejects tampered ciphertext (GCM authentication)', () => {
    const [iv, tag, data] = encrypt('do-not-tamper').split(':');
    // Flip the first hex digit of the ciphertext body — still valid hex, but the
    // GCM auth tag will no longer verify, so decryption must throw.
    const flipped = (data[0] === 'a' ? 'b' : 'a') + data.slice(1);
    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });
});

describe('maskKey', () => {
  it('shows only the last four characters', () => {
    expect(maskKey('abcdefghij1234')).toBe('●●●●●●●●●●1234');
  });

  it('fully masks very short inputs', () => {
    expect(maskKey('ab')).toBe('●●●●');
  });
});

// ── The master key is read on first use, not at import (P1.1, #196) ──
// Each test loads a fresh copy of the module with the environment it needs, because the key, once
// read, is kept for the life of the module — exactly as the import-time read kept it.
describe('the master key, read on first use', () => {
  const saved = process.env.MASTER_ENCRYPTION_KEY;
  const MESSAGE = 'CRITICAL FATAL: MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).';

  async function freshModule(key: string | undefined) {
    if (key === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = key;
    vi.resetModules();
    return import('./encryption');
  }

  afterEach(() => {
    if (saved === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = saved;
    vi.resetModules();
  });

  it('imports without a key; the first use throws the same message it used to throw at import', async () => {
    const enc = await freshModule(undefined);
    expect(() => enc.decrypt('00:00:00')).toThrow(MESSAGE);
    expect(() => enc.encrypt('x')).toThrow(MESSAGE);
    expect(() => enc.deriveSubKey('alayra-nexus/test/v1')).toThrow(MESSAGE);
    expect(() => enc.assertMasterKey()).toThrow(MESSAGE);
    // Masking needs no key at all.
    expect(enc.maskKey('abcdef1234')).toBe('●●●●●●1234');
  });

  it('a key of the wrong length is refused on first use, not at import', async () => {
    const enc = await freshModule('ab'.repeat(16));
    expect(() => enc.assertMasterKey()).toThrow(MESSAGE);
  });

  it('opens a value sealed before the change, byte for byte, and derives the same subkey', async () => {
    // Produced by the pre-P1.1 module under the key 'a' x 64. A changed algorithm, key handling or
    // encoding would fail here, and every stored provider key would become unreadable.
    const enc = await freshModule('a'.repeat(64));
    const sealed = '6ecc206b8a3433c6e136297d50f14f19:4d4036d46df7b28fde03bf3c019d0ec2:'
      + '91cd1f45ec1da88e26a682b83c8b2f775c3637313c422f85b4';
    expect(enc.decrypt(sealed)).toBe('sk-test-fixed-vector-0001');
    expect(enc.deriveSubKey('alayra-nexus/test/vector/v1').toString('hex'))
      .toBe('4fda23f026bc01ecba96818d193a3d5312e6e494e99d680e5bda9601674d0662');
  });

  it('a key set after import is the key used, and stays the key once read', async () => {
    const enc = await freshModule(undefined);
    process.env.MASTER_ENCRYPTION_KEY = 'a'.repeat(64);
    const sealed = enc.encrypt('sk-test-late');
    process.env.MASTER_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(enc.decrypt(sealed)).toBe('sk-test-late');
  });
});
