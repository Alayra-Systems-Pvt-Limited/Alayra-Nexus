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

// The authenticator app, in twenty lines. RFC 6238 (TOTP) over RFC 4226 (HOTP),
// SHA-1, 6 digits, 30-second steps — the parameters every authenticator app and our
// gateway's src/lib/totp.ts share. Implemented here rather than imported from src/
// because this package tests the gateway as a black box: nothing under test may be
// reused to verify itself. node:crypto only, no dependency.

import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code an authenticator app would show for this secret right now. */
export function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}
