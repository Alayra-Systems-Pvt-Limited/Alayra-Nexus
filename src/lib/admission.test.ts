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

import { describe, it, expect, vi } from 'vitest';

// admission.ts imports the real ioredis client, which connects (and throws when
// REDIS_URL is unset) at module load. These are pure-helper tests, so we mock the
// Redis module — no connection is attempted. The admitKey / reconcileTpm Lua paths
// are exercised against a real Redis in the integration suite (Phase 13).
vi.mock('./redis', () => ({ redis: { eval: vi.fn() } }));

import { rpmKey, tpmKey, RPM_TPM_WINDOW_SECONDS } from './admission';

describe('admission key derivation', () => {
  it('namespaces RPM keys per key id', () => {
    expect(rpmKey('abc123')).toBe('nexus:rpm:abc123');
  });

  it('namespaces TPM keys per key id', () => {
    expect(tpmKey('abc123')).toBe('nexus:tpm:abc123');
  });

  it('keeps RPM and TPM counters in separate namespaces', () => {
    expect(rpmKey('same')).not.toBe(tpmKey('same'));
  });

  it('uses a 60-second window', () => {
    expect(RPM_TPM_WINDOW_SECONDS).toBe(60);
  });
});
