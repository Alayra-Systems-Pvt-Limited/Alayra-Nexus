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
  const store = { kv: new Map<string, string>(), ttl: new Map<string, number>(), sets: new Map<string, Set<string>>() };
  const prismaMock = {
    adminAuth: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    // Accounts (Phase 7.13a). `count` is what isUnclaimed reads: 0 active owners = an unclaimed
    // gateway, which is the state every Phase 6 test below assumes and must keep passing in.
    adminUser: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    adminRecoveryCode: { findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    adminApiToken: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  };
  return { store, prismaMock };
});

vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: prismaMock }));
vi.mock('../lib/redis', () => ({
  redis: {
    get:    vi.fn(async (k: string) => store.kv.get(k) ?? null),
    // Honours the `EX <seconds>` form the service uses, so TTL-dependent logic is
    // exercised rather than accidentally bypassed.
    // Honours `EX <seconds>` and `KEEPTTL` (the lastSeenAt refresh must not extend a session).
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
    // Set commands back the per-user session index (Phase 7.13b).
    sadd:      vi.fn(async (k: string, ...ms: string[]) => { const s = store.sets.get(k) ?? new Set<string>(); ms.forEach((m) => s.add(m)); store.sets.set(k, s); return ms.length; }),
    srem:      vi.fn(async (k: string, ...ms: string[]) => { const s = store.sets.get(k); if (!s) return 0; let n = 0; ms.forEach((m) => { if (s.delete(m)) n++; }); return n; }),
    smembers:  vi.fn(async (k: string) => [...(store.sets.get(k) ?? [])]),
    sismember: vi.fn(async (k: string, m: string) => (store.sets.get(k)?.has(m) ? 1 : 0)),
    mget:      vi.fn(async (ks: string[]) => ks.map((k) => store.kv.get(k) ?? null)),
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

/** The master password alone, the way the dashboard sent it before accounts existed. */
const withPassword = (password: string, code?: string) => ({ password, code });

function noTotpEnrolled() {
  prismaMock.adminAuth.findUnique.mockResolvedValue(null);
}
function totpEnabled(secret: string) {
  prismaMock.adminAuth.findUnique.mockResolvedValue({ id: 'singleton', totpSecret: `enc:${secret}`, confirmedAt: new Date() });
}
/** An owner exists: the gateway has been claimed, and the master password is no longer a sign-in. */
function claimed() {
  prismaMock.adminUser.count.mockResolvedValue(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.kv.clear();
  store.ttl.clear();
  store.sets.clear();
  process.env.ADMIN_PASSWORD = PASSWORD;
  // Unclaimed unless a test says otherwise. Every Phase 6 expectation below is written against this
  // state on purpose: it is what an existing deployment looks like the moment it upgrades, and the
  // whole design goal was that nothing about sign-in changes until the operator claims.
  prismaMock.adminUser.count.mockResolvedValue(0);
  prismaMock.adminUser.findUnique.mockResolvedValue(null);
  prismaMock.adminRecoveryCode.findUnique.mockResolvedValue(null);
  prismaMock.adminRecoveryCode.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.adminRecoveryCode.createMany.mockResolvedValue({ count: 10 });
});

describe('login — without a second factor', () => {
  beforeEach(noTotpEnrolled);

  it('issues a session token for the right password', async () => {
    const res = await auth.login(withPassword(PASSWORD), SOURCE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(await auth.isValidSession(res.token)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const res = await auth.login(withPassword('nope'), SOURCE);
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects when no ADMIN_PASSWORD is configured, rather than accepting anything', async () => {
    delete process.env.ADMIN_PASSWORD;
    expect(await auth.login(withPassword(''), SOURCE)).toMatchObject({ ok: false });
    expect(await auth.login(withPassword('guess'), SOURCE)).toMatchObject({ ok: false });
  });

  it('ignores a supplied code when no factor is enrolled', async () => {
    expect((await auth.login(withPassword(PASSWORD, '123456'), SOURCE)).ok).toBe(true);
  });
});

describe('login — with a second factor', () => {
  const secret = generateTotpSecret();
  beforeEach(() => totpEnabled(secret));

  it('demands a code when the password is right and none was given', async () => {
    expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ ok: false, reason: 'totp_required' });
  });

  // The response must not distinguish "password wrong" from "password right, code
  // missing" — that would turn the login form into a password oracle.
  it('reports a wrong password as invalid, never as totp_required', async () => {
    expect(await auth.login(withPassword('nope'), SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('accepts the right password with a valid code', async () => {
    expect((await auth.login(withPassword(PASSWORD, totp(secret)), SOURCE)).ok).toBe(true);
  });

  it('rejects the right password with a wrong code', async () => {
    expect(await auth.login(withPassword(PASSWORD, '000000'), SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  // Otherwise someone who already holds the password has an unthrottled oracle that
  // confirms it, forever, at no cost.
  it('counts a missing code against the lockout', async () => {
    for (let i = 1; i < auth.MAX_LOGIN_ATTEMPTS; i++) {
      expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ reason: 'totp_required' });
    }
    expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  // The normal two-step sign-in must not be penalised: the first submit has no code
  // because the user cannot know a factor is enrolled until the server says so.
  it('does not penalise the legitimate two-step sign-in', async () => {
    for (let i = 0; i < 20; i++) {
      expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ reason: 'totp_required' });
      expect((await auth.login(withPassword(PASSWORD, totp(secret)), SOURCE)).ok).toBe(true); // success clears the counter
    }
  });

  it('accepts an unused recovery code in place of a TOTP code, once', async () => {
    // `userId: null` is what a code minted before accounts existed looks like — the pre-claim path
    // matches those by hash alone, because there was nobody to own them yet.
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValueOnce({ id: 'r1', usedAt: null, userId: null });
    prismaMock.adminRecoveryCode.update.mockResolvedValue({});
    expect((await auth.login(withPassword(PASSWORD, 'aaaaa-bbbbb'), SOURCE)).ok).toBe(true);
    expect(prismaMock.adminRecoveryCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
    );
  });

  it('refuses a recovery code that was already spent', async () => {
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValue({ id: 'r1', usedAt: new Date(), userId: null });
    expect(await auth.login(withPassword(PASSWORD, 'aaaaa-bbbbb'), SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('lockout', () => {
  beforeEach(noTotpEnrolled);

  it('locks the source out after the configured number of failures', async () => {
    for (let i = 1; i < auth.MAX_LOGIN_ATTEMPTS; i++) {
      expect(await auth.login(withPassword('wrong'), SOURCE)).toMatchObject({ reason: 'invalid' });
    }
    expect(await auth.login(withPassword('wrong'), SOURCE)).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  it('refuses even the correct password while locked out', async () => {
    for (let i = 0; i < auth.MAX_LOGIN_ATTEMPTS; i++) await auth.login(withPassword('wrong'), SOURCE);
    expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  it('locks one source without affecting another', async () => {
    for (let i = 0; i < auth.MAX_LOGIN_ATTEMPTS; i++) await auth.login(withPassword('wrong'), SOURCE);
    expect((await auth.login(withPassword(PASSWORD), '198.51.100.2')).ok).toBe(true);
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await auth.login(withPassword('wrong'), SOURCE);
    await auth.login(withPassword('wrong'), SOURCE);
    expect((await auth.login(withPassword(PASSWORD), SOURCE)).ok).toBe(true);
    // A fresh run of failures is needed to lock out again.
    for (let i = 1; i < auth.MAX_LOGIN_ATTEMPTS; i++) {
      expect(await auth.login(withPassword('wrong'), SOURCE)).toMatchObject({ reason: 'invalid' });
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

// The second factor belongs to a PERSON now (Phase 7.13a), not to the gateway. Same rules as
// Phase 6 — unconfirmed enrolment changes nothing, a bad code issues no recovery codes — but every
// one of them now applies to an account, which is what makes two admins able to hold their own.
describe('enrolment (per user)', () => {
  const USER = 'user-1';

  it('does not enable the factor until a code confirms it', async () => {
    prismaMock.adminUser.update.mockResolvedValue({});
    const { secret } = await auth.beginTotpEnrolment(USER, 'ada@example.com');

    // Enrolled but unconfirmed: the gateway must still behave as though 2FA is off.
    prismaMock.adminUser.findUnique.mockResolvedValue({ totpSecret: `enc:${secret}`, totpConfirmedAt: null });
    expect(await auth.getTotpState(USER)).toEqual({ enabled: false, pending: true });
  });

  it('labels the authenticator entry with the person, not a generic "admin"', async () => {
    // Several people may now hold codes for the same gateway, so the label has to tell them apart.
    prismaMock.adminUser.update.mockResolvedValue({});
    const { otpauthUri } = await auth.beginTotpEnrolment(USER, 'ada@example.com');
    expect(otpauthUri).toContain('ada%40example.com');
  });

  it('rejects a bad confirmation code and issues no recovery codes', async () => {
    prismaMock.adminUser.findUnique.mockResolvedValue({ totpSecret: 'enc:GEZDGNBVGY3TQOJQ', totpConfirmedAt: null });
    const res = await auth.confirmTotp(USER, '000000');
    expect(res.ok).toBe(false);
    expect(res.recoveryCodes).toBeUndefined();
    expect(prismaMock.adminRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it('confirms with a valid code and returns single-use recovery codes owned by that person', async () => {
    const secret = generateTotpSecret();
    prismaMock.adminUser.findUnique.mockResolvedValue({ totpSecret: `enc:${secret}`, totpConfirmedAt: null });
    prismaMock.adminUser.update.mockResolvedValue({});

    const res = await auth.confirmTotp(USER, totp(secret));
    expect(res.ok).toBe(true);
    expect(res.recoveryCodes).toHaveLength(10);
    expect(new Set(res.recoveryCodes).size).toBe(10);
    // Written against the user: codes are theirs, and only theirs, to spend.
    expect(prismaMock.adminRecoveryCode.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ userId: USER })]),
    });
    expect(prismaMock.adminRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it('will not disable a factor without a valid code', async () => {
    const secret = generateTotpSecret();
    prismaMock.adminUser.findUnique.mockResolvedValue({ totpSecret: `enc:${secret}`, totpConfirmedAt: new Date() });
    expect(await auth.disableTotp(USER, '000000')).toBe(false);
    expect(prismaMock.adminUser.update).not.toHaveBeenCalled();
  });

  it('refuses a recovery code belonging to someone else', async () => {
    // The lookup is by hash, so ownership has to be checked on the row that comes back. Without
    // that check one person's code would unlock anyone's account — exactly the sharing this
    // phase set out to end.
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValue({ id: 'r1', usedAt: null, userId: 'someone-else' });
    expect(await auth.consumeRecoveryCode(USER, 'aaaa-bbbb')).toBe(false);
    expect(prismaMock.adminRecoveryCode.update).not.toHaveBeenCalled();

    prismaMock.adminRecoveryCode.findUnique.mockResolvedValue({ id: 'r1', usedAt: null, userId: USER });
    prismaMock.adminRecoveryCode.update.mockResolvedValue({});
    expect(await auth.consumeRecoveryCode(USER, 'aaaa-bbbb')).toBe(true);
  });

  it('will not let a pre-accounts code be spent as somebody’s', async () => {
    // A legacy code (userId null) must not satisfy a per-user check — only the pre-claim path,
    // which has its own function, may match those.
    prismaMock.adminRecoveryCode.findUnique.mockResolvedValue({ id: 'r1', usedAt: null, userId: null });
    expect(await auth.consumeRecoveryCode(USER, 'aaaa-bbbb')).toBe(false);
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

  it('resolves a live token to its role and rejects a revoked one', async () => {
    prismaMock.adminApiToken.update.mockResolvedValue({});
    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't1', revokedAt: null, role: 'owner' });
    expect(await auth.verifyAdminApiToken('nxa_abc')).toBe('owner');

    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't2', revokedAt: null, role: 'viewer' });
    expect(await auth.verifyAdminApiToken('nxa_view')).toBe('viewer');

    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't1', revokedAt: new Date(), role: 'owner' });
    expect(await auth.verifyAdminApiToken('nxa_abc')).toBeNull();
  });

  it('treats a token row with no role as owner (upgrade-safe)', async () => {
    prismaMock.adminApiToken.update.mockResolvedValue({});
    prismaMock.adminApiToken.findUnique.mockResolvedValueOnce({ id: 't1', revokedAt: null });
    expect(await auth.verifyAdminApiToken('nxa_old')).toBe('owner');
  });

  it('rejects a token without the prefix without touching the database', async () => {
    expect(await auth.verifyAdminApiToken('some-session-token')).toBeNull();
    expect(prismaMock.adminApiToken.findUnique).not.toHaveBeenCalled();
  });

  it('mints a viewer token when asked, defaulting to owner', async () => {
    prismaMock.adminApiToken.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't1', name: 'ci', ...data }));
    expect((await auth.createAdminApiToken('reader', 'viewer')).role).toBe('viewer');
    expect((await auth.createAdminApiToken('ci')).role).toBe('owner');
  });
});

describe('roles (Phase 6.5)', () => {
  beforeEach(noTotpEnrolled);

  it('a token-minted session carries its role, and an unknown token has none', async () => {
    const owner = await auth.createSession();                    // defaults to owner
    const viewer = await auth.createSession({ role: 'viewer' });
    expect(await auth.resolveSession(owner.token)).toMatchObject({ role: 'owner', userId: null });
    expect(await auth.resolveSession(viewer.token)).toMatchObject({ role: 'viewer', userId: null });
    expect(await auth.resolveSession('nope')).toBeNull();
  });

  it('a legacy "1"-valued session resolves to owner', async () => {
    // Written directly, as a session minted before 7.13a would be: a bare string, not JSON.
    // An upgrade must not sign everyone out.
    const { createHash } = await import('crypto');
    const token = 'legacy-token';
    store.kv.set('nexus:adminsession:' + createHash('sha256').update(token).digest('hex'), '1');
    expect(await auth.resolveSession(token)).toEqual({ userId: null, role: 'owner', name: null });
  });

  it('password login yields an owner session with role in the result', async () => {
    const res = await auth.login(withPassword(PASSWORD), SOURCE);
    expect(res).toMatchObject({ ok: true, role: 'owner' });
    if (res.ok) expect(await auth.resolveSession(res.token)).toMatchObject({ role: 'owner' });
  });

  it('an admin token used as the password mints a session at the token’s role, no TOTP', async () => {
    // A viewer token presented in the password field logs in read-only, even with 2FA on.
    const secret = generateTotpSecret();
    totpEnabled(secret);
    prismaMock.adminApiToken.update.mockResolvedValue({});
    prismaMock.adminApiToken.findUnique.mockResolvedValue({ id: 't1', revokedAt: null, role: 'viewer' });

    const res = await auth.login(withPassword('nxa_sometoken'), SOURCE);
    expect(res).toMatchObject({ ok: true, role: 'viewer' });
    if (res.ok) expect(await auth.resolveSession(res.token)).toMatchObject({ role: 'viewer' });
  });
});

// ── Accounts (Phase 7.13a) ────────────────────────────────────────────────────

describe('login — once the gateway is claimed', () => {
  const EMAIL = 'ada@example.com';
  let hash: string;

  beforeEach(async () => {
    noTotpEnrolled();
    claimed();
    const { hashPassword } = await import('../lib/password');
    hash = await hashPassword('a properly long password');
  });

  const account = (over: Record<string, unknown> = {}) => ({
    id: 'u1', email: EMAIL, name: 'Ada', passwordHash: hash, role: 'admin',
    status: 'active', totpSecret: null, totpConfirmedAt: null, ...over,
  });

  it('signs in with email and password, and names the person in the result', async () => {
    prismaMock.adminUser.findUnique.mockResolvedValue(account());
    prismaMock.adminUser.update.mockResolvedValue({});

    const res = await auth.login({ email: EMAIL, password: 'a properly long password' }, SOURCE);
    expect(res).toMatchObject({ ok: true, role: 'admin', userId: 'u1', name: 'Ada' });
    // The session names its subject, so authority is read from the account, not baked into the token.
    if (res.ok) expect(await auth.resolveSession(res.token)).toMatchObject({ userId: 'u1', role: 'admin', name: 'Ada' });
  });

  it('REFUSES the master password once an owner exists', async () => {
    // The whole point of the phase. A shared env secret that still signed in would put the audit
    // trail back to saying "password" and make offboarding a fiction.
    prismaMock.adminUser.findUnique.mockResolvedValue(null);
    expect(await auth.login(withPassword(PASSWORD), SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await auth.login({ email: EMAIL, password: PASSWORD }, SOURCE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a suspended account, and still counts the attempt', async () => {
    prismaMock.adminUser.findUnique.mockResolvedValue(account({ status: 'suspended' }));
    expect(await auth.login({ email: EMAIL, password: 'a properly long password' }, SOURCE))
      .toMatchObject({ ok: false, reason: 'suspended' });
    // A suspended account's password is still a live secret; an attacker holding it must not get an
    // unthrottled way to learn that suspension is all that stands in their way.
    expect(store.kv.size).toBeGreaterThan(0);
  });

  it('refuses an SSO account signing in with a password', async () => {
    // passwordHash is null for an SSO account, and verifyPassword on null is a guaranteed false —
    // which IS the mechanism, not an accident of ordering.
    prismaMock.adminUser.findUnique.mockResolvedValue(account({ passwordHash: null, source: 'sso' }));
    expect(await auth.login({ email: EMAIL, password: 'anything at all here' }, SOURCE))
      .toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('answers an unknown email exactly like a wrong password', async () => {
    prismaMock.adminUser.findUnique.mockResolvedValue(null);
    expect(await auth.login({ email: 'nobody@example.com', password: 'a properly long password' }, SOURCE))
      .toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('demands the person’s own second factor when they have one', async () => {
    const secret = generateTotpSecret();
    prismaMock.adminUser.findUnique.mockResolvedValue(
      account({ totpSecret: `enc:${secret}`, totpConfirmedAt: new Date() }),
    );
    prismaMock.adminUser.update.mockResolvedValue({});

    expect(await auth.login({ email: EMAIL, password: 'a properly long password' }, SOURCE))
      .toMatchObject({ ok: false, reason: 'totp_required' });
    expect((await auth.login({ email: EMAIL, password: 'a properly long password', code: totp(secret) }, SOURCE)).ok)
      .toBe(true);
  });
});

describe('resolveSession — authority is read live, not baked in', () => {
  it('kills the session of an account that has been removed or suspended', async () => {
    claimed();
    const { token } = await auth.createSession({ userId: 'u1' });

    prismaMock.adminUser.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada', role: 'owner', status: 'active' });
    expect(await auth.resolveSession(token)).toMatchObject({ userId: 'u1', role: 'owner' });

    // Suspended: out on the very next request, not whenever the session happens to expire.
    prismaMock.adminUser.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada', role: 'owner', status: 'suspended' });
    expect(await auth.resolveSession(token)).toBeNull();

    // Removed: likewise.
    prismaMock.adminUser.findUnique.mockResolvedValue(null);
    expect(await auth.resolveSession(token)).toBeNull();
  });

  it('reflects a role change immediately, without reissuing the session', async () => {
    claimed();
    const { token } = await auth.createSession({ userId: 'u1' });

    prismaMock.adminUser.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada', role: 'owner', status: 'active' });
    expect(await auth.resolveSession(token)).toMatchObject({ role: 'owner' });

    // Demoted. A session carrying its role would keep owner authority for up to twelve hours.
    prismaMock.adminUser.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada', role: 'viewer', status: 'active' });
    expect(await auth.resolveSession(token)).toMatchObject({ role: 'viewer' });
  });
});

describe('isPasswordBearerAllowed — the two doors', () => {
  it('is open only while unclaimed AND no legacy second factor is confirmed', async () => {
    noTotpEnrolled();
    expect(await auth.isPasswordBearerAllowed()).toBe(true); // fresh/upgraded gateway: nothing changes

    totpEnabled(generateTotpSecret());
    expect(await auth.isPasswordBearerAllowed()).toBe(false); // Phase 6 closed this one

    noTotpEnrolled();
    claimed();
    expect(await auth.isPasswordBearerAllowed()).toBe(false); // Phase 7.13a closes this one
  });
});
