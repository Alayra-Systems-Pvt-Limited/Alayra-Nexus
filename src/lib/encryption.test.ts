import { describe, it, expect } from 'vitest';
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
