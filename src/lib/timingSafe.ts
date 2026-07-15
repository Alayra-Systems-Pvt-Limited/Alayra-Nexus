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

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `===` on strings short-circuits at the first differing byte, so the time it takes
 * to reject a candidate reveals how many leading characters were right. Repeated
 * across a network that is enough to recover a secret byte by byte.
 *
 * `crypto.timingSafeEqual` fixes that but throws when the two buffers differ in
 * length — and branching on the length would itself leak the secret's length. Hashing
 * both sides first yields two fixed-width digests, so exactly one constant-time
 * comparison runs regardless of what the caller supplied.
 *
 * The sha256 here is a length-equaliser for a constant-time compare, NOT password storage:
 * nothing is persisted, so a slow hash (bcrypt/argon2) is the wrong tool — it would defeat the
 * whole point (equal, fixed-width buffers) and add nothing, since the values are compared in
 * memory and never written down. (CodeQL flags the digest call generically.)
 *
 * A missing expected value never matches, including against an empty candidate.
 */
export function safeEqual(candidate: string | undefined | null, expected: string | undefined | null): boolean {
  if (!expected || candidate == null) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected,  'utf8').digest();
  return timingSafeEqual(a, b);
}
