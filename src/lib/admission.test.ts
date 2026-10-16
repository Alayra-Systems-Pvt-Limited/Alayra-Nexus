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
// One mock function for every copy of the module, so a test that reloads admission.ts under another
// environment still sees the same `redis.eval`. The setting is cleared before the module loads, so
// the default-mode tests mean the same with it set in the shell.
const evalMock = vi.hoisted(() => {
  delete process.env.NEXUS_TPM_RECONCILE;
  delete process.env.NEXUS_TPM_ESTIMATE;
  return vi.fn();
});
vi.mock('./redis', () => ({ redis: { eval: evalMock } }));

import { beforeEach, afterEach } from 'vitest';
import {
  rpmKey, tpmKey, usersKey, admitUser, reconcileTpm, readTpmReconcile, effectiveTpmReconcile, ADMIT_LUA, RECONCILE_LUA,
  CHARGE_LUA, MAX_USAGE_TOKENS,
  RPM_TPM_WINDOW_SECONDS, MAXUSERS_WINDOW_SECONDS,
} from './admission';
import { redis } from './redis';
import { MemoryKv } from './kv/memory';
import { rateWindow } from './rateWindow';

describe('admission key derivation', () => {
  it('namespaces RPM keys per key id', () => {
    expect(rpmKey('abc123')).toBe('nexus:rpm:abc123');
  });

  it('namespaces TPM keys per key id', () => {
    expect(tpmKey('abc123')).toBe('nexus:tpm:abc123');
  });

  it('namespaces the distinct-users set per key id', () => {
    expect(usersKey('abc123')).toBe('nexus:users:abc123');
  });

  it('keeps RPM and TPM counters in separate namespaces', () => {
    expect(rpmKey('same')).not.toBe(tpmKey('same'));
  });

  it('uses a 60-second window', () => {
    expect(RPM_TPM_WINDOW_SECONDS).toBe(60);
  });

  it('counts distinct users over a rolling day by default', () => {
    expect(MAXUSERS_WINDOW_SECONDS).toBe(86400);
  });
});

describe('admitUser — per-key Max Users cap', () => {
  beforeEach(() => { vi.mocked(redis.eval).mockReset(); });

  it('admits without touching Redis when the request carries no user id', async () => {
    // No identity signal means the cap is unenforceable — a missing `user` must never block traffic.
    await expect(admitUser('key-1', 5, null)).resolves.toBe(true);
    await expect(admitUser('key-1', 5, undefined)).resolves.toBe(true);
    await expect(admitUser('key-1', 5, '')).resolves.toBe(true);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('admits when the script reports the user is known or the key has room', async () => {
    vi.mocked(redis.eval).mockResolvedValue(1 as never);
    await expect(admitUser('key-1', 5, 'user-a')).resolves.toBe(true);
  });

  it('rejects a new user once the key is at its cap', async () => {
    vi.mocked(redis.eval).mockResolvedValue(0 as never);
    await expect(admitUser('key-1', 5, 'user-z')).resolves.toBe(false);
  });

  it('passes the key set, user id, cap, and window to the script', async () => {
    vi.mocked(redis.eval).mockResolvedValue(1 as never);
    await admitUser('key-1', 5, 'user-a', 3600);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, 'nexus:users:key-1', 'user-a', '5', '3600',
    );
  });

  it('clamps a nonsensical cap to at least one user', async () => {
    vi.mocked(redis.eval).mockResolvedValue(1 as never);
    await admitUser('key-1', 0, 'user-a', 3600);
    expect(vi.mocked(redis.eval).mock.calls[0][4]).toBe('1');
  });
});

// ── Reconciling a TPM reservation to what the request really used ────────────────────────────────

const NOON = Date.UTC(2026, 7, 11, 12, 0, 30);
const TPM = 'nexus:tpm:key-1';
const CURRENT = rateWindow(TPM, NOON, RPM_TPM_WINDOW_SECONDS).current;

/** A fresh copy of admission.ts, loaded with NEXUS_TPM_RECONCILE (and NEXUS_TPM_ESTIMATE) set. */
async function loadWith(value: string, estimate = '') {
  vi.stubEnv('NEXUS_TPM_RECONCILE', value);
  vi.stubEnv('NEXUS_TPM_ESTIMATE', estimate);
  vi.resetModules();
  return import('./admission');
}

describe('NEXUS_TPM_RECONCILE', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('defaults to refunding only, as before', () => {
    expect(readTpmReconcile(undefined)).toBe('refund');
    expect(readTpmReconcile('')).toBe('refund');
    expect(readTpmReconcile(' Refund ')).toBe('refund');
  });

  it('selects both directions with "two-way"', () => {
    expect(readTpmReconcile('two-way')).toBe('two-way');
    expect(readTpmReconcile('TWO-WAY')).toBe('two-way');
  });

  it('keeps refunding only, and says so, for a value it does not know', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readTpmReconcile('both')).toBe('refund');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXUS_TPM_RECONCILE="both" was ignored'));
  });

  it('runs two-way under the fast estimate, and warns only when the setting said otherwise', () => {
    // The estimate can run low on crafted text, and only two-way charges that back.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(effectiveTpmReconcile('fast', undefined)).toBe('two-way');
    expect(effectiveTpmReconcile('fast', '')).toBe('two-way');
    expect(effectiveTpmReconcile('fast', 'two-way')).toBe('two-way');
    expect(warn).not.toHaveBeenCalled();
    expect(effectiveTpmReconcile('fast', 'refund')).toBe('two-way');
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('NEXUS_TPM_RECONCILE="refund" was ignored'));
    expect(effectiveTpmReconcile('tokenizer', undefined)).toBe('refund');
    expect(effectiveTpmReconcile('tokenizer', 'two-way')).toBe('two-way');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, number]>([
    ['', 'fast', 0], ['two-way', 'fast', 0], ['refund', 'fast', 1], ['twoway', 'fast', 1], ['twoway', '', 1], ['refund', '', 0],
  ])('at load, NEXUS_TPM_RECONCILE=%j with NEXUS_TPM_ESTIMATE=%j logs %i warning', async (reconcile, estimate, count) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadWith(reconcile, estimate);
    expect(warn).toHaveBeenCalledTimes(count);
  });
});

describe('reconcileTpm', () => {
  beforeEach(() => { evalMock.mockReset(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refunds the unused part of a reservation', async () => {
    await reconcileTpm('key-1', 100, 30, NOON);
    expect(evalMock).toHaveBeenCalledWith(RECONCILE_LUA, 1, TPM, '70', '60', String(NOON));
  });

  it('by default, leaves a window alone when usage ran over the reservation', async () => {
    await reconcileTpm('key-1', 100, 150, NOON);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('with two-way, adds what usage ran over the reservation', async () => {
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, 150, NOON);
    expect(evalMock).toHaveBeenCalledWith(mod.CHARGE_LUA, 1, TPM, '50', '60', String(NOON));
  });

  it('with two-way, still refunds an over-reservation the same way', async () => {
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, 30, NOON);
    expect(evalMock).toHaveBeenCalledWith(mod.RECONCILE_LUA, 1, TPM, '70', '60', String(NOON));
  });

  it('with two-way, rounds a fractional excess up and ignores an exact match', async () => {
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, 100, NOON);
    expect(evalMock).not.toHaveBeenCalled();
    await mod.reconcileTpm('key-1', 100, 100.4, NOON);
    expect(evalMock).toHaveBeenCalledWith(mod.CHARGE_LUA, 1, TPM, '1', '60', String(NOON));
  });

  it('with two-way, never charges a usage figure that is not a number', async () => {
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, Number.NaN, NOON);
    await mod.reconcileTpm('key-1', 100, Number.POSITIVE_INFINITY, NOON);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('ignores a negative usage figure rather than emptying the window', async () => {
    // A refund of reserved + 5,000,000 would be clamped to everything the window holds.
    await reconcileTpm('key-1', 100, -5_000_000, NOON);
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, -1, NOON);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('still counts a usage figure reported as a string of digits, within the same bounds', async () => {
    const asReported = (figure: string) => figure as unknown as number;
    await reconcileTpm('key-1', 100, asReported('30'), NOON);
    expect(evalMock).toHaveBeenLastCalledWith(RECONCILE_LUA, 1, TPM, '70', '60', String(NOON));
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, asReported('150'), NOON);
    expect(evalMock).toHaveBeenLastCalledWith(mod.CHARGE_LUA, 1, TPM, '50', '60', String(NOON));
    evalMock.mockClear();
    for (const bad of ['-5', 'abc', '1e12']) await mod.reconcileTpm('key-1', 100, asReported(bad), NOON);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('ignores an absurd usage figure rather than blocking the key on it', async () => {
    const mod = await loadWith('two-way');
    await mod.reconcileTpm('key-1', 100, 1e12, NOON);
    await mod.reconcileTpm('key-1', 100, MAX_USAGE_TOKENS + 1, NOON);
    expect(evalMock).not.toHaveBeenCalled();
    await mod.reconcileTpm('key-1', 100, MAX_USAGE_TOKENS, NOON);
    expect(evalMock).toHaveBeenCalledWith(mod.CHARGE_LUA, 1, TPM, String(MAX_USAGE_TOKENS - 100), '60', String(NOON));
  });

  it('with the fast estimate, charges an overrun with reconcile left unset, or set to refund', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const reconcile of ['', 'refund']) {
      const mod = await loadWith(reconcile, 'fast');
      await mod.reconcileTpm('key-1', 100, 150, NOON);
      expect(evalMock).toHaveBeenLastCalledWith(mod.CHARGE_LUA, 1, TPM, '50', '60', String(NOON));
    }
    warn.mockRestore();
  });
});

describe('reconcileTpm against a store — what the next request sees', () => {
  afterEach(() => { vi.unstubAllEnvs(); evalMock.mockReset(); });

  /** Reserve 100, report 150, then ask for 60 more against a 200-token limit. */
  async function overrunThenAdmit(mode: string): Promise<unknown> {
    const mod = await loadWith(mode);
    const kv = new MemoryKv(0);
    evalMock.mockImplementation((lua: string, n: number, ...rest: (string | number)[]) => kv.eval(lua, n, ...rest));
    expect(await kv.eval(ADMIT_LUA, 2, 'nexus:rpm:key-1', TPM, 1000, 200, 100, 60, NOON)).toBe(1);
    await mod.reconcileTpm('key-1', 100, 150, NOON);
    return kv.eval(ADMIT_LUA, 2, 'nexus:rpm:key-1', TPM, 1000, 200, 60, 60, NOON);
  }

  it('by default, the window forgets the overrun and admits past the limit', async () => {
    expect(await overrunThenAdmit('refund')).toBe(1);       // 100 + 60 <= 200, though 210 were used
  });

  it('with two-way, the window holds the overrun and refuses', async () => {
    expect(await overrunThenAdmit('two-way')).toBe(0);      // 150 + 60 > 200
  });
});

describe('CHARGE_LUA — its in-memory twin', () => {
  it("adds the excess and keeps the window's deadline", async () => {
    const kv = new MemoryKv(0);
    await kv.set(CURRENT, '100', 'EX', 30);
    expect(await kv.eval(CHARGE_LUA, 1, TPM, 50, 60, NOON)).toBe(150);
    expect(await kv.ttl(CURRENT)).toBeLessThanOrEqual(30);
  });

  it('gives a counter it creates the two-window deadline admission gives', async () => {
    const kv = new MemoryKv(0);
    expect(await kv.eval(CHARGE_LUA, 1, TPM, 50, 60, NOON)).toBe(50);
    expect(await kv.ttl(CURRENT)).toBeGreaterThan(60);
    expect(await kv.ttl(CURRENT)).toBeLessThanOrEqual(120);
  });

  it('is a no-op for a non-positive amount', async () => {
    const kv = new MemoryKv(0);
    await kv.set(CURRENT, '42');
    expect(await kv.eval(CHARGE_LUA, 1, TPM, 0, 60, NOON)).toBe(42);
    expect(await kv.get(CURRENT)).toBe('42');
  });
});
