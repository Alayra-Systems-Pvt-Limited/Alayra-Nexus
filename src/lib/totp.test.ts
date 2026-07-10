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

import { describe, it, expect } from 'vitest';
import {
  base32Encode, base32Decode, hotp, totp, verifyTotp,
  generateTotpSecret, otpauthUri, counterFor, TOTP_STEP_SECONDS,
} from './totp';

// The shared secret used by both RFCs' test vectors: the ASCII string
// "12345678901234567890" (20 bytes).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe('base32', () => {
  it('encodes the RFC secret to the value authenticator apps expect', () => {
    expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips arbitrary bytes', () => {
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x7a, 0x99, 0x01]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('tolerates lowercase, padding, and spacing (users paste these)', () => {
    expect(base32Decode('gezdgnbv gy3tqojq=')).toEqual(base32Decode('GEZDGNBVGY3TQOJQ'));
  });

  it('rejects a non-base32 character rather than silently decoding it', () => {
    expect(() => base32Decode('ABC1')).toThrow(/Invalid base32/);
  });
});

// RFC 4226, Appendix D — HOTP with the secret above, counters 0..9, 6 digits.
describe('hotp (RFC 4226 test vectors)', () => {
  const expected = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
  it.each(expected.map((code, counter) => [counter, code]))('counter %i → %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter as number)).toBe(code);
  });
});

// RFC 6238, Appendix B — TOTP with SHA-1 and the same secret, 8 digits.
describe('totp (RFC 6238 test vectors)', () => {
  const vectors: [number, string][] = [
    [59,          '94287082'],
    [1111111109,  '07081804'],
    [1111111111,  '14050471'],
    [1234567890,  '89005924'],
    [2000000000,  '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('unix time %i → %s', (unixSeconds, code) => {
    expect(hotp(RFC_SECRET, counterFor(unixSeconds * 1000), 8)).toBe(code);
  });
});

describe('verifyTotp', () => {
  const at = 1_700_000_000_000;

  it('accepts the current code', () => {
    expect(verifyTotp(totp(RFC_SECRET_B32, at), RFC_SECRET_B32, at)).toBe(true);
  });

  it('accepts one step of drift in either direction', () => {
    const stepMs = TOTP_STEP_SECONDS * 1000;
    expect(verifyTotp(totp(RFC_SECRET_B32, at - stepMs), RFC_SECRET_B32, at)).toBe(true);
    expect(verifyTotp(totp(RFC_SECRET_B32, at + stepMs), RFC_SECRET_B32, at)).toBe(true);
  });

  it('rejects two steps of drift', () => {
    const stepMs = TOTP_STEP_SECONDS * 1000;
    expect(verifyTotp(totp(RFC_SECRET_B32, at - 2 * stepMs), RFC_SECRET_B32, at)).toBe(false);
    expect(verifyTotp(totp(RFC_SECRET_B32, at + 2 * stepMs), RFC_SECRET_B32, at)).toBe(false);
  });

  it('rejects a wrong code, and a code for a different secret', () => {
    expect(verifyTotp('000000', RFC_SECRET_B32, at)).toBe(false);
    expect(verifyTotp(totp(generateTotpSecret(), at), RFC_SECRET_B32, at)).toBe(false);
  });

  it('rejects anything that is not six digits, without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ', '000000\n0']) {
      expect(verifyTotp(bad, RFC_SECRET_B32, at)).toBe(false);
    }
    expect(verifyTotp(undefined as unknown as string, RFC_SECRET_B32, at)).toBe(false);
  });

  it('tolerates a space-separated code as typed from a phone', () => {
    const code = totp(RFC_SECRET_B32, at);
    expect(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, RFC_SECRET_B32, at)).toBe(true);
  });
});

describe('generateTotpSecret', () => {
  it('produces a decodable 160-bit secret', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(seen.size).toBe(50);
  });
});

describe('otpauthUri', () => {
  it('carries the parameters an authenticator needs', () => {
    const uri = otpauthUri('ABCD', 'admin');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Alayra%20Nexus:admin\?/);
    expect(uri).toContain('secret=ABCD');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('escapes an issuer or account containing separators', () => {
    expect(otpauthUri('ABCD', 'a:b/c')).toContain('a%3Ab%2Fc');
  });
});
