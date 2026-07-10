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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// An in-memory stand-in for the Redis commands this service uses. TTLs are recorded
// rather than ticked; the lockout tests set them directly.
const { store, prismaMock } = vi.hoisted(() => {
  const store = { kv: new Map<string, string>(), ttl: new Map<string, number>() };
  const prismaMock = {
    adminAuth: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    adminRecoveryCode: { findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    adminApiToken: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  };
  return { store, prismaMock };
});

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../lib/redis', () => ({
  redis: {
    get:    vi.fn(async (k: string) => store.kv.get(k) ?? null),
    // Honours the `EX <seconds>` form the service uses, so TTL-dependent logic is
    // exercised rather than accidentally bypassed.
    set:    vi.fn(async (k: string, v: string, ex?: string, secs?: number) => {
      store.kv.set(k, v);
      if (ex === 'EX' && typeof secs === 'number') store.ttl.set(k, secs);
      return 'OK';
    }),
    del:    vi.fn(async (...ks: string[]) => { ks.forEach(k => { store.kv.delete(k); store.ttl.delete(k); }); return ks.length; }),
    incr:   vi.fn(async (k: string) => { const n = parseInt(store.kv.get(k) ?? '0', 10) + 1; store.kv.set(k, String(n)); return n; }),
    expire: vi.fn(async (k: string, s: number) => { store.ttl.set(k, s); return 1; }),
    ttl:    vi.fn(async (k: string) => (store.kv.has(k) ? (store.ttl.get(k) ?? -1) : -2)),
    exists: vi.fn(async (k: string) => (store.kv.has(k) ? 1 : 0)),
  },
}));
// The real AES-256-GCM envelope needs a key; the test bootstrap sets one. Swap it for
// an identity transform so a failure here points at auth logic, not at crypto.
vi.mock('../lib/encryption', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

import * as auth from './adminAuth.service';
import { totp, generateTotpSecret } from '../lib/totp';

const PASSWORD = 'correct-horse-battery-staple';
const SOURCE   = '203.0.113.7';

function noTotpEnrolled() {
  prismaMock.adminAuth.findUnique.mockResolvedValue(null);
}
function totpEnabled(secret: string) {
  prismaMock.adminAuth.findUnique.mockResolvedValue({ id: 'singleton', totpSecret: `enc:${secret}`, confirmedAt: new Date() });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.kv.clear();
  store.ttl.clear();
  process.env.ADMIN_PASSWORD = PASSWORD;
  prismaMock.adminRecoveryCode.findUnique.mockResolvedValue(null);
  prismaMock.adminRecoveryCode.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.adminRecoveryCode.createMany.mockResolvedValue({ count: 10 });
});

describe('login — without a second factor', () => {
  beforeEach(noTotpEnrolled);

  it('issues a session token for the right password', async () => {
    const res = await auth.login(PASSWORD, undefined, SOURCE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(await auth.isValidSession(res.token)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const res = await auth.login('nope', undefined, SOURCE);
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects when no ADMIN_PASSWORD is configured, rather than accepting anything', async () => {
    delete process.env.ADMIN_PASSWORD;
    expect(await auth.login('', undefined, SOURCE)).toMatchObject({ ok: false });
    expect(await auth.login('guess', undefined, SOURCE)).toMatchObject({ ok: false });
  });

  it('ignores a supplied code when no factor is enrolled', async () => {
    expect((await auth.login(PASSWORD, '123456', SOURCE)).ok).toBe(true);
  });
});

describe('login — with a second factor', () => {
  const secret = generateTotpSecret();
  beforeEach(() => totpEnabled(secret));

  it('demands a code when the password is right and none was given', async () => {
    expect(await auth.login(PASSWORD, undefined, SOURCE)).toMatchObject({ ok: false, reason: 'totp_required' });
  });

  // The response must not distinguish "password wrong" from "password right, code
  // missing" — that would turn the login form into a password oracle.
  it('reports a wrong password as invalid, never as totp_required', async () => {
    expect(await auth.login('nope', undefined, SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('accepts the right password with a valid code', async () => {
    expect((await auth.login(PASSWORD, totp(secret), SOURCE)).ok).toBe(true);
  });

  it('rejects the right password with a wrong code', async () => {
    expect(await auth.login(PASSWORD, '000000', SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('accepts an unused recovery code in place of a TOTP code, once', async () => {
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValueOnce({ id: 'r1', usedAt: null });
    prismaMock.adminRecoveryCode.update.mockResolvedValue({});
    expect((await auth.login(PASSWORD, 'aaaaa-bbbbb', SOURCE)).ok).toBe(true);
    expect(prismaMock.adminRecoveryCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
    );
  });

  it('refuses a recovery code that was already spent', async () => {
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValue({ id: 'r1', usedAt: new Date() });
    expect(await auth.login(PASSWORD, 'aaaaa-bbbbb', SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('lockout', () => {
  beforeEach(noTotpEnrolled);

  it('locks the source out after the configured number of failures', async () => {
    for (let i = 1; i < auth.MAX_LOGIN_ATTEMPTS; i++) {
      expect(await auth.login('wrong', undefined, SOURCE)).toMatchObject({ reason: 'invalid' });
    }
    expect(await auth.login('wrong', undefined, SOURCE)).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  it('refuses even the correct password while locked out', async () => {
    for (let i = 0; i < auth.MAX_LOGIN_ATTEMPTS; i++) await auth.login('wrong', undefined, SOURCE);
    expect(await auth.login(PASSWORD, undefined, SOURCE)).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  it('locks one source without affecting another', async () => {
    for (let i = 0; i < auth.MAX_LOGIN_ATTEMPTS; i++) await auth.login('wrong', undefined, SOURCE);
    expect((await auth.login(PASSWORD, undefined, '198.51.100.2')).ok).toBe(true);
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await auth.login('wrong', undefined, SOURCE);
    await auth.login('wrong', undefined, SOURCE);
    expect((await auth.login(PASSWORD, undefined, SOURCE)).ok).toBe(true);
    // A fresh run of failures is needed to lock out again.
    for (let i = 1; i < auth.MAX_LOGIN_ATTEMPTS; i++) {
      expect(await auth.login('wrong', undefined, SOURCE)).toMatchObject({ reason: 'invalid' });
    }
  });
});

describe('sessions', () => {
  beforeEach(noTotpEnrolled);

  it('stores the token by hash, so the raw token is not recoverable from Redis', async () => {
    const { token } = await auth.createSession();
    expect([...store.kv.keys()].some(k => k.includes(token))).toBe(false);
  });

  it('invalidates a destroyed session', async () => {
    const { token } = await auth.createSession();
    await auth.destroySession(token);
    expect(await auth.isValidSession(token)).toBe(false);
  });

  it('rejects an unknown or empty token', async () => {
    expect(await auth.isValidSession('deadbeef')).toBe(false);
    expect(await auth.isValidSession('')).toBe(false);
  });
});

describe('enrolment', () => {
  it('does not enable the factor until a code confirms it', async () => {
    prismaMock.adminAuth.upsert.mockResolvedValue({});
    const { secret } = await auth.beginTotpEnrolment();

    // Enrolled but unconfirmed: the gateway must still behave as though 2FA is off.
    prismaMock.adminAuth.findUnique.mockResolvedValue({ totpSecret: `enc:${secret}`, confirmedAt: null });
    expect(await auth.isTwoFactorEnabled()).toBe(false);
    expect(await auth.getTotpState()).toEqual({ enabled: false, pending: true });
  });

  it('rejects a bad confirmation code and issues no recovery codes', async () => {
    prismaMock.adminAuth.findUnique.mockResolvedValue({ totpSecret: 'enc:GEZDGNBVGY3TQOJQ', confirmedAt: null });
    const res = await auth.confirmTotp('000000');
    expect(res.ok).toBe(false);
    expect(res.recoveryCodes).toBeUndefined();
    expect(prismaMock.adminRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it('confirms with a valid code and returns single-use recovery codes', async () => {
    const secret = generateTotpSecret();
    prismaMock.adminAuth.findUnique.mockResolvedValue({ totpSecret: `enc:${secret}`, confirmedAt: null });
    prismaMock.adminAuth.update.mockResolvedValue({});

    const res = await auth.confirmTotp(totp(secret));
    expect(res.ok).toBe(true);
    expect(res.recoveryCodes).toHaveLength(10);
    expect(new Set(res.recoveryCodes).size).toBe(10);
  });

  it('will not disable a factor without a valid code', async () => {
    const secret = generateTotpSecret();
    totpEnabled(secret);
    expect(await auth.disableTotp('000000')).toBe(false);
    expect(prismaMock.adminAuth.update).not.toHaveBeenCalled();
  });
});

describe('admin API tokens', () => {
  it('returns the plaintext once and stores only its hash', async () => {
    prismaMock.adminApiToken.create.mockImplementation(async ({ data }: { data: { tokenHash: string; maskedKey: string } }) => ({
      id: 't1', name: 'ci', ...data,
    }));
    const { token } = await auth.createAdminApiToken('ci');
    expect(token.startsWith('nxa_')).toBe(true);
    const stored = prismaMock.adminApiToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.maskedKey).not.toBe(token);
  });

  it('accepts a live token and rejects a revoked one', async () => {
    prismaMock.adminApiToken.update.mockResolvedValue({});
    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't1', revokedAt: null });
    expect(await auth.verifyAdminApiToken('nxa_abc')).toBe(true);

    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't1', revokedAt: new Date() });
    expect(await auth.verifyAdminApiToken('nxa_abc')).toBe(false);
  });

  it('rejects a token without the prefix without touching the database', async () => {
    expect(await auth.verifyAdminApiToken('some-session-token')).toBe(false);
    expect(prismaMock.adminApiToken.findUnique).not.toHaveBeenCalled();
  });
});
