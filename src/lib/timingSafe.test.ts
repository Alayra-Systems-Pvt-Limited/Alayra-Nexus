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
import { safeEqual } from './timingSafe';

describe('safeEqual', () => {
  it('accepts an exact match', () => {
    expect(safeEqual('correct-horse', 'correct-horse')).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(safeEqual('wrong', 'correct-horse')).toBe(false);
  });

  // The whole point: timingSafeEqual throws on unequal lengths, so a naive guard
  // would have to branch on length — which leaks the secret's length.
  it('handles differing lengths without throwing', () => {
    expect(safeEqual('a', 'a-much-longer-secret')).toBe(false);
    expect(safeEqual('a-much-longer-candidate', 'a')).toBe(false);
  });

  it('never matches when no secret is configured', () => {
    expect(safeEqual('anything', undefined)).toBe(false);
    expect(safeEqual('anything', null)).toBe(false);
    expect(safeEqual('anything', '')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual('', undefined)).toBe(false);
  });

  it('rejects a null or undefined candidate', () => {
    expect(safeEqual(undefined, 'secret')).toBe(false);
    expect(safeEqual(null, 'secret')).toBe(false);
  });

  it('rejects a prefix of the secret', () => {
    expect(safeEqual('correct-hors', 'correct-horse')).toBe(false);
  });

  it('is byte-exact, not normalizing', () => {
    expect(safeEqual('Secret', 'secret')).toBe(false);
    expect(safeEqual('secret ', 'secret')).toBe(false);
  });

  it('compares multi-byte characters correctly', () => {
    expect(safeEqual('pässwörd', 'pässwörd')).toBe(true);
    expect(safeEqual('pässwörd', 'password')).toBe(false);
  });
});
