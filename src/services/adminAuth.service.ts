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

import { createHash, randomBytes } from 'crypto';
import { prisma }            from '../lib/prisma';
import { redis }             from '../lib/redis';
import { encrypt, decrypt }  from '../lib/encryption';
import { safeEqual }         from '../lib/timingSafe';
import { verifyTotp, generateTotpSecret, otpauthUri } from '../lib/totp';
import { notify } from './notifications.service';
import { adminLockoutMessage } from '../lib/notify';

// ── Admin authentication (Phase 6) ────────────────────────────────────────────
//
// Before this, the dashboard held the raw ADMIN_PASSWORD in sessionStorage and sent
// it as the bearer token on every request. A second factor cannot be bolted onto
// that: whoever holds the password bypasses it. So a login now exchanges the
// password (and, once enrolled, a TOTP code) for a short-lived opaque session token.
//
// Enforcement is conditional and additive. Until a TOTP secret is *confirmed*, the
// password still works as a bearer token, exactly as it always has, so upgrading the
// gateway changes nothing. Confirming a second factor is what closes that door.

const SESSION_PREFIX  = 'nexus:adminsession:';
const LOCKOUT_PREFIX  = 'nexus:adminlock:';
const ATTEMPT_PREFIX  = 'nexus:adminfail:';

/** How long a dashboard session lives without re-authenticating. */
export const SESSION_TTL_SECONDS = parseInt(process.env.ADMIN_SESSION_TTL_SECONDS ?? '43200', 10); // 12h
/** Failed logins before the source is locked out. */
export const MAX_LOGIN_ATTEMPTS  = parseInt(process.env.ADMIN_MAX_LOGIN_ATTEMPTS ?? '5', 10);
/** How long a lockout lasts. */
export const LOCKOUT_SECONDS     = parseInt(process.env.ADMIN_LOCKOUT_SECONDS ?? '900', 10); // 15m

const SINGLETON = 'singleton';

// sha256 is the right tool here, not a slow password hash (bcrypt/argon2). Everything hashed through
// this is a high-entropy random value we generated — session tokens (256-bit), admin API tokens
// (192-bit), recovery codes (64-bit) — not a human-chosen password. A slow hash defends low-entropy
// secrets against offline guessing; these are unguessable regardless, and a fast digest is what lets
// a token be verified by an O(1) indexed lookup instead of a table scan. (CodeQL flags the call name
// generically; the input, not the algorithm, is what makes a hash safe.)
function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

// ── TOTP state ────────────────────────────────────────────────────────────────

export interface TotpState {
  /** A secret exists and has been proven by a valid code. Enforcement is on. */
  enabled: boolean;
  /** A secret exists but was never confirmed — enrolment was abandoned. */
  pending: boolean;
}

export async function getTotpState(): Promise<TotpState> {
  const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
  return {
    enabled: !!row?.totpSecret && !!row.confirmedAt,
    pending: !!row?.totpSecret && !row.confirmedAt,
  };
}

/** True once a second factor is confirmed — the point at which the password alone stops working. */
export async function isTwoFactorEnabled(): Promise<boolean> {
  return (await getTotpState()).enabled;
}

/**
 * Begin enrolment: mint a secret, store it encrypted but *unconfirmed*, and hand back
 * the provisioning URI. The secret is returned exactly once. Nothing changes about
 * how the gateway authenticates until `confirmTotp` succeeds, so a half-finished
 * enrolment can never lock the operator out.
 */
export async function beginTotpEnrolment(account = 'admin'): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret();
  const enc    = encrypt(secret);
  await prisma.adminAuth.upsert({
    where:  { id: SINGLETON },
    create: { id: SINGLETON, totpSecret: enc, confirmedAt: null },
    update: { totpSecret: enc, confirmedAt: null },
  });
  return { secret, otpauthUri: otpauthUri(secret, account) };
}

/**
 * Prove possession of the enrolled secret. On success the factor becomes mandatory
 * and a fresh set of single-use recovery codes is issued — returned once, stored
 * only as hashes.
 */
export async function confirmTotp(code: string): Promise<{ ok: boolean; recoveryCodes?: string[] }> {
  const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
  if (!row?.totpSecret) return { ok: false };
  if (!verifyTotp(code, decrypt(row.totpSecret))) return { ok: false };

  await prisma.adminAuth.update({ where: { id: SINGLETON }, data: { confirmedAt: new Date() } });
  const recoveryCodes = await regenerateRecoveryCodes();
  return { ok: true, recoveryCodes };
}

/** Check a code against the confirmed secret without changing any state. */
export async function verifyTotpCode(code: string): Promise<boolean> {
  const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
  if (!row?.totpSecret || !row.confirmedAt) return false;
  return verifyTotp(code, decrypt(row.totpSecret));
}

/** Turn the second factor off. Requires a currently-valid code or recovery code. */
export async function disableTotp(code: string): Promise<boolean> {
  const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
  if (!row?.totpSecret || !row.confirmedAt) return false;

  const bySecret   = verifyTotp(code, decrypt(row.totpSecret));
  const byRecovery = bySecret ? false : await consumeRecoveryCode(code);
  if (!bySecret && !byRecovery) return false;

  await prisma.adminAuth.update({ where: { id: SINGLETON }, data: { totpSecret: null, confirmedAt: null } });
  await prisma.adminRecoveryCode.deleteMany({});
  return true;
}

// ── Recovery codes ────────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;

/** Ten fresh codes. Any previously-issued code stops working. Returned once. */
export async function regenerateRecoveryCodes(): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    // 8 bytes = 64 bits of entropy, formatted xxxx-xxxx-xxxx-xxxx. Recovery codes are stored only as
    // fast (sha256) hashes, so their strength has to come from length: 64 bits is infeasible to
    // brute-force offline even if the hash table leaked, where the old 40-bit code was not.
    const hex = randomBytes(8).toString('hex'); // 16 hex chars
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  });
  await prisma.adminRecoveryCode.deleteMany({});
  await prisma.adminRecoveryCode.createMany({
    data: codes.map((c) => ({ codeHash: sha256(c) })),
  });
  return codes;
}

/**
 * Spend a recovery code. Single use: the row is stamped rather than deleted, so an
 * operator can see that one was used. Returns false for an unknown or spent code.
 */
export async function consumeRecoveryCode(code: string): Promise<boolean> {
  const normalized = (code ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const row = await prisma.adminRecoveryCode.findUnique({ where: { codeHash: sha256(normalized) } });
  if (!row || row.usedAt) return false;
  await prisma.adminRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}

export async function countUnusedRecoveryCodes(): Promise<number> {
  return prisma.adminRecoveryCode.count({ where: { usedAt: null } });
}

// ── Lockout ───────────────────────────────────────────────────────────────────

/**
 * Seconds remaining on a lockout for this source, or 0 when not locked out.
 *
 * Redis returns -2 for a missing key and -1 for a key with no expiry. Only -2 means
 * "not locked out": a lockout key that somehow lost its TTL must keep denying access
 * rather than silently opening it, so it is treated as a full window.
 */
export async function lockoutRemaining(source: string): Promise<number> {
  const ttl = await redis.ttl(LOCKOUT_PREFIX + sha256(source));
  if (ttl > 0)   return ttl;
  if (ttl === -1) return LOCKOUT_SECONDS;
  return 0;
}

/**
 * Count a failed attempt. Once the threshold is crossed the source is locked out for
 * a fixed window and the counter is cleared, so the lockout does not extend forever
 * under a sustained attack — it simply repeats.
 */
export async function recordFailedAttempt(source: string): Promise<{ lockedOut: boolean; retryAfter: number }> {
  const key = ATTEMPT_PREFIX + sha256(source);
  const fails = await redis.incr(key);
  if (fails === 1) await redis.expire(key, LOCKOUT_SECONDS);

  if (fails >= MAX_LOGIN_ATTEMPTS) {
    await redis.set(LOCKOUT_PREFIX + sha256(source), '1', 'EX', LOCKOUT_SECONDS);
    await redis.del(key);
    return { lockedOut: true, retryAfter: LOCKOUT_SECONDS };
  }
  return { lockedOut: false, retryAfter: 0 };
}

export async function clearFailedAttempts(source: string): Promise<void> {
  await redis.del(ATTEMPT_PREFIX + sha256(source), LOCKOUT_PREFIX + sha256(source));
}

// ── Roles (Phase 6.5 RBAC) ──────────────────────────────────────────────────────
// Two levels: "owner" holds full control; "viewer" is read-only (GET routes only, every
// mutation refused). The raw admin password and every dashboard login are always owner;
// a viewer credential can only be a viewer-scoped admin API token. Anything unrecognised
// resolves to owner, so a session or token minted before 6.5 keeps the access it had.

export type AdminRole = 'owner' | 'viewer';

export function asRole(v: string | null | undefined): AdminRole {
  return v === 'viewer' ? 'viewer' : 'owner';
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function createSession(role: AdminRole = 'owner'): Promise<{ token: string; expiresIn: number }> {
  const token = randomBytes(32).toString('hex');
  // The session value is now the role (was a bare '1'); getSessionRole reads it back, and an
  // older '1'-valued session resolves to owner via asRole, so upgrades keep working.
  await redis.set(SESSION_PREFIX + sha256(token), role, 'EX', SESSION_TTL_SECONDS);
  return { token, expiresIn: SESSION_TTL_SECONDS };
}

/** The role a live session carries, or null when it is absent/expired. Stored by hash, so a
 *  Redis dump cannot be replayed as a session. */
export async function getSessionRole(token: string): Promise<AdminRole | null> {
  if (!token) return null;
  const v = await redis.get(SESSION_PREFIX + sha256(token));
  return v === null ? null : asRole(v);
}

export async function isValidSession(token: string): Promise<boolean> {
  return (await getSessionRole(token)) !== null;
}

export async function destroySession(token: string): Promise<void> {
  if (token) await redis.del(SESSION_PREFIX + sha256(token));
}

// ── Login ─────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; token: string; expiresIn: number; role: AdminRole }
  | { ok: false; reason: 'locked_out'; retryAfter: number }
  | { ok: false; reason: 'totp_required' }
  | { ok: false; reason: 'invalid' };

/**
 * Exchange credentials for a session token.
 *
 * `totp_required` is only returned when the password was *correct* and a code was
 * absent — a wrong password always yields `invalid`, so the response never reveals
 * whether a password was right before the second factor is checked.
 *
 * Every unsuccessful outcome feeds the same lockout counter, including
 * `totp_required`. Exempting it would leave an attacker who already holds the password
 * with an unthrottled oracle that confirms it, forever, at no cost. The legitimate
 * two-step sign-in (password, then password + code) is not penalised: a success clears
 * the counter, so only an *abandoned* sign-in accumulates.
 */
// Fire-and-forget operator alert (Phase 6.4) when admin sign-in locks out. Always raised: a lockout
// means someone is guessing the admin password, which is precisely the alert an operator must still
// see in the dashboard when they never set up email (7.11 — the armed check that used to gate this
// keyed off the email config). notify() records it and decides on its own whether to send it out.
async function alertAdminLockout(source: string): Promise<void> {
  await notify(adminLockoutMessage(source));
}

export async function login(password: string, code: string | undefined, source: string): Promise<LoginResult> {
  const retryAfter = await lockoutRemaining(source);
  if (retryAfter > 0) return { ok: false, reason: 'locked_out', retryAfter };

  // Record a failed attempt and, when it is the one that trips the lockout, fire the
  // operator alert once (fire-and-forget). Every failure path routes through here so the
  // alert cannot be reached by only some of them.
  const fail = async () => {
    const r = await recordFailedAttempt(source);
    if (r.lockedOut) void alertAdminLockout(source).catch(() => {});
    return r;
  };

  // An admin API token may be presented in place of the password, so a viewer (or an
  // owner) can obtain a dashboard session without the master password. Tokens already
  // bypass the second factor by design — they are for callers that cannot present one —
  // so this path mints a session at the token's own role and does not consult TOTP.
  const tokenRole = await verifyAdminApiToken(password);
  if (tokenRole) {
    await clearFailedAttempts(source);
    const { token, expiresIn } = await createSession(tokenRole);
    return { ok: true, token, expiresIn, role: tokenRole };
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!safeEqual(password, expected)) {
    const { lockedOut, retryAfter: ra } = await fail();
    return lockedOut ? { ok: false, reason: 'locked_out', retryAfter: ra } : { ok: false, reason: 'invalid' };
  }

  const { enabled } = await getTotpState();
  if (enabled) {
    if (!code) {
      const { lockedOut, retryAfter: ra } = await fail();
      return lockedOut
        ? { ok: false, reason: 'locked_out', retryAfter: ra }
        : { ok: false, reason: 'totp_required' };
    }
    const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
    const bySecret = !!row?.totpSecret && verifyTotp(code, decrypt(row.totpSecret));
    const byRecovery = bySecret ? false : await consumeRecoveryCode(code);
    if (!bySecret && !byRecovery) {
      const { lockedOut, retryAfter: ra } = await fail();
      return lockedOut ? { ok: false, reason: 'locked_out', retryAfter: ra } : { ok: false, reason: 'invalid' };
    }
  }

  await clearFailedAttempts(source);
  const { token, expiresIn } = await createSession('owner');
  return { ok: true, token, expiresIn, role: 'owner' };
}

// ── Admin API tokens ──────────────────────────────────────────────────────────
// Scripts and CI cannot present a second factor. They authenticate with a long-lived
// token that the operator can see and revoke, rather than with the admin password.

const TOKEN_PREFIX = 'nxa_';

export async function createAdminApiToken(name: string, role: AdminRole = 'owner'): Promise<{ id: string; name: string; token: string; maskedKey: string; role: AdminRole }> {
  // The route validates with Zod, but this is an exported service function: enforce the same
  // bound here so a direct caller can never persist a blank or oversized name.
  const normalizedName = name.trim();
  if (normalizedName.length < 1 || normalizedName.length > 80) {
    throw new Error('Token name must be between 1 and 80 characters.');
  }
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const maskedKey = `${token.slice(0, 8)}••••${token.slice(-4)}`;
  const row = await prisma.adminApiToken.create({
    data: { name: normalizedName, tokenHash: sha256(token), maskedKey, role },
  });
  return { id: row.id, name: row.name, token, maskedKey, role: asRole(row.role) };
}

/**
 * Resolve a bearer token to a live admin API token, returning its role — or null when the
 * token is not one of ours, is revoked, or is unknown. An indexed hash lookup, so no timing
 * comparison is needed and the plaintext is never stored.
 */
export async function verifyAdminApiToken(token: string): Promise<AdminRole | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await prisma.adminApiToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.revokedAt) return null;
  // Fire and forget: a last-used timestamp must never slow down or fail a request.
  void prisma.adminApiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return asRole(row.role);
}

export async function listAdminApiTokens() {
  return prisma.adminApiToken.findMany({
    where:   { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, name: true, maskedKey: true, role: true, lastUsedAt: true, createdAt: true },
  });
}

export async function revokeAdminApiToken(id: string): Promise<void> {
  await prisma.adminApiToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}
