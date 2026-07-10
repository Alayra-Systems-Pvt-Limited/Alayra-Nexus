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

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// ── TOTP (RFC 6238) over HOTP (RFC 4226) ──────────────────────────────────────
// Implemented directly on node's crypto rather than pulled from a package: the
// algorithm is a HMAC, a truncation, and a modulo, and both RFCs publish test
// vectors — so correctness here is demonstrated rather than trusted, and the auth
// path takes on no third-party supply-chain surface.
//
// SHA-1 is not a choice; it is what every authenticator app implements, and its use
// inside HMAC is unaffected by the collision attacks that retired SHA-1 for
// signatures.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** How many steps either side of "now" are accepted. 1 tolerates ±30s of clock skew. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, uppercase, no padding — the encoding authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32. Padding, lowercase, and separating spaces are all tolerated. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded — the size RFC 4226 recommends. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * HOTP (RFC 4226 §5.3): HMAC-SHA1 the counter, take the 4 bytes at the offset named
 * by the low nibble of the last byte, mask the sign bit, and reduce mod 10^digits.
 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset]     & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) <<  8) |
     (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The counter for a given moment: whole time steps since the Unix epoch. */
export function counterFor(atMs: number = Date.now(), step: number = TOTP_STEP_SECONDS): number {
  return Math.floor(atMs / 1000 / step);
}

/** The current code for a base32 secret. */
export function totp(secretBase32: string, atMs: number = Date.now(), digits: number = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), counterFor(atMs), digits);
}

/**
 * Verify a submitted code against the secret, accepting `window` steps of drift in
 * either direction.
 *
 * Every candidate is compared in constant time, and the loop does not exit early on a
 * match: a short-circuit here would make a correct-but-skewed code measurably faster
 * to check than a wrong one, which reveals the device's clock offset.
 */
export function verifyTotp(
  token: string,
  secretBase32: string,
  atMs: number = Date.now(),
  window: number = TOTP_WINDOW,
): boolean {
  const submitted = (token ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(submitted)) return false;

  const secret = base32Decode(secretBase32);
  const base = counterFor(atMs);
  let matched = false;
  for (let drift = -window; drift <= window; drift++) {
    const candidate = hotp(secret, base + drift);
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(submitted, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app consumes, normally via a QR code. The
 * secret is in it, so it is shown once at enrolment and never stored or logged.
 */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Alayra Nexus'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
