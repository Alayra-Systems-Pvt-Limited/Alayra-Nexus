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
import { asRole, type AdminRole } from '../lib/roles';
import { verifyPassword } from '../lib/password';
import { isUnclaimed } from './adminUsers.service';

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
//
// ── Accounts (Phase 7.13a) ────────────────────────────────────────────────────
//
// The same argument, one level up. A second factor cannot be made a *person's* while there is only
// one shared password, and an audit trail cannot name anyone. So sign-in is now email + password
// against an account, and ADMIN_PASSWORD changes job: it claims the first owner account and
// authorises the reset-wipe, and it is refused as a sign-in the moment an owner exists — because a
// shared env secret that still logged in would put the trail straight back to saying "password".
//
// Nothing changes at upgrade. Until the gateway is claimed, every path below behaves exactly as it
// did in Phase 6: the password signs in, the singleton second factor applies. The change happens
// when the operator claims, not when the code ships.

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

/**
 * The pre-accounts second factor: one secret for the whole gateway, shared by everyone who knew the
 * password. Read in exactly two places now — the claim flow, which copies it onto the first owner,
 * and the pre-claim sign-in path, which must keep behaving as it did in Phase 6. Every other caller
 * uses the per-user functions below.
 */
export async function getLegacyTotpState(): Promise<TotpState> {
  const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
  return {
    enabled: !!row?.totpSecret && !!row.confirmedAt,
    pending: !!row?.totpSecret && !row.confirmedAt,
  };
}

/**
 * True when the raw ADMIN_PASSWORD is still accepted as a bearer token.
 *
 * Two doors have to be open for that, and both close permanently once shut: the gateway must be
 * unclaimed (no account exists to sign in as), and no legacy second factor may be confirmed (Phase
 * 6's rule — a password that kept working as a bearer would bypass the factor it was meant to add).
 */
export async function isPasswordBearerAllowed(): Promise<boolean> {
  if (!(await isUnclaimed())) return false;
  return !(await getLegacyTotpState()).enabled;
}

/** A person's second factor. */
export async function getTotpState(userId: string): Promise<TotpState> {
  const row = await prisma.adminUser.findUnique({ where: { id: userId } });
  return {
    enabled: !!row?.totpSecret && !!row.totpConfirmedAt,
    pending: !!row?.totpSecret && !row.totpConfirmedAt,
  };
}

/**
 * Begin enrolment: mint a secret, store it encrypted but *unconfirmed*, and hand back
 * the provisioning URI. The secret is returned exactly once. Nothing changes about
 * how the gateway authenticates until `confirmTotp` succeeds, so a half-finished
 * enrolment can never lock the operator out.
 */
export async function beginTotpEnrolment(userId: string, account = 'admin'): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret();
  const enc    = encrypt(secret);
  await prisma.adminUser.update({
    where: { id: userId },
    data:  { totpSecret: enc, totpConfirmedAt: null },
  });
  return { secret, otpauthUri: otpauthUri(secret, account) };
}

/**
 * Prove possession of the enrolled secret. On success the factor becomes mandatory
 * and a fresh set of single-use recovery codes is issued — returned once, stored
 * only as hashes.
 */
export async function confirmTotp(userId: string, code: string): Promise<{ ok: boolean; recoveryCodes?: string[] }> {
  const row = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!row?.totpSecret) return { ok: false };
  if (!verifyTotp(code, decrypt(row.totpSecret))) return { ok: false };

  await prisma.adminUser.update({ where: { id: userId }, data: { totpConfirmedAt: new Date() } });
  const recoveryCodes = await regenerateRecoveryCodes(userId);
  return { ok: true, recoveryCodes };
}

/** Check a code against a person's confirmed secret without changing any state. */
export async function verifyTotpCode(userId: string, code: string): Promise<boolean> {
  const row = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!row?.totpSecret || !row.totpConfirmedAt) return false;
  return verifyTotp(code, decrypt(row.totpSecret));
}

/** Turn a person's second factor off. Requires a currently-valid code or recovery code. */
export async function disableTotp(userId: string, code: string): Promise<boolean> {
  const row = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!row?.totpSecret || !row.totpConfirmedAt) return false;

  const bySecret   = verifyTotp(code, decrypt(row.totpSecret));
  const byRecovery = bySecret ? false : await consumeRecoveryCode(userId, code);
  if (!bySecret && !byRecovery) return false;

  await prisma.adminUser.update({ where: { id: userId }, data: { totpSecret: null, totpConfirmedAt: null } });
  await prisma.adminRecoveryCode.deleteMany({ where: { userId } });
  return true;
}

// ── Recovery codes ────────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;

/** Ten fresh codes for one person. Any previously-issued code of theirs stops working. Returned once. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    // 8 bytes = 64 bits of entropy, formatted xxxx-xxxx-xxxx-xxxx. Recovery codes are stored only as
    // fast (sha256) hashes, so their strength has to come from length: 64 bits is infeasible to
    // brute-force offline even if the hash table leaked, where the old 40-bit code was not.
    const hex = randomBytes(8).toString('hex'); // 16 hex chars
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  });
  await prisma.adminRecoveryCode.deleteMany({ where: { userId } });
  await prisma.adminRecoveryCode.createMany({
    data: codes.map((c) => ({ codeHash: sha256(c), userId })),
  });
  return codes;
}

/**
 * Spend one of a person's recovery codes. Single use: the row is stamped rather than deleted, so an
 * operator can see that one was used. Returns false for an unknown or spent code.
 *
 * The code must belong to the user presenting it. The lookup is by hash (that is what is indexed),
 * so ownership is checked on the row that comes back — otherwise one person's code would unlock
 * anyone's account, which is precisely the sharing this phase set out to end.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalized = (code ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const row = await prisma.adminRecoveryCode.findUnique({ where: { codeHash: sha256(normalized) } });
  if (!row || row.usedAt || row.userId !== userId) return false;
  await prisma.adminRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return prisma.adminRecoveryCode.count({ where: { userId, usedAt: null } });
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

// ── Sessions ──────────────────────────────────────────────────────────────────
//
// A session names its subject, not its authority. Two shapes are stored:
//
//   {"v":1,"uid":"…"}      an account. Role and status are read from the account on every request.
//   {"v":1,"role":"admin"} no account behind it — an admin API token exchanged for a session.
//
// Baking the role into the session at sign-in would be faster and wrong: demoting someone would
// leave their old authority live for up to twelve hours, and suspending them would not lock them
// out until their session happened to expire. Reading the account per request costs one indexed
// primary-key lookup on routes that are nowhere near the proxy hot path, and buys the property an
// operator actually expects — remove someone, and they are out on their very next request.

interface SessionValue {
  v: 1 | 2;
  uid?: string;
  role?: AdminRole;
  // v2 (Phase 7.13b): where and when this session lives, so a person can SEE their sessions.
  // Descriptive only — never an authentication factor: any client can claim any user-agent,
  // and an address proves nothing about who is typing. The one honest use of this data is
  // showing it to its owner so they can recognise a session that is not theirs and end it.
  ua?: string;
  ip?: string;
  createdAt?: number;   // epoch ms
  lastSeenAt?: number;  // epoch ms, refreshed at most once a minute
}

/** One of a person's live sessions, as shown on the "Where you're signed in" panel. */
export interface SessionView {
  id: string;           // the session's storage hash — identifies it without revealing the token
  ua: string | null;
  ip: string | null;
  createdAt: number | null;
  lastSeenAt: number | null;
  current: boolean;
}

export interface SessionMeta { ua?: string | null; ip?: string | null }

/** Per-user set of live session hashes, so "your sessions" is a lookup, not a Redis scan. */
const SESSION_INDEX_PREFIX = 'nexus:adminsessionidx:';

/** How stale lastSeenAt may get before a request refreshes it — one write a minute, not per request. */
const LAST_SEEN_REFRESH_MS = 60_000;

/** Who is making this request. `userId` is null for a token-minted or pre-accounts session. */
export interface SessionIdentity {
  userId: string | null;
  role: AdminRole;
  name: string | null;
}

export type SessionSubject = { userId: string } | { role: AdminRole };

export async function createSession(
  subject: SessionSubject = { role: 'owner' },
  meta: SessionMeta = {},
): Promise<{ token: string; expiresIn: number }> {
  const token = randomBytes(32).toString('hex');
  const hash  = sha256(token);
  const now   = Date.now();
  const value: SessionValue = {
    v: 2,
    ...('userId' in subject ? { uid: subject.userId } : { role: subject.role }),
    ...(meta.ua ? { ua: meta.ua.slice(0, 300) } : {}),
    ...(meta.ip ? { ip: meta.ip } : {}),
    createdAt: now,
    lastSeenAt: now,
  };
  await redis.set(SESSION_PREFIX + hash, JSON.stringify(value), 'EX', SESSION_TTL_SECONDS);

  // Index the session under its account so "your sessions" is a set lookup. The index's TTL is
  // pushed out on every new session; members whose session has since expired are pruned on read.
  if ('userId' in subject) {
    await redis.sadd(SESSION_INDEX_PREFIX + subject.userId, hash);
    await redis.expire(SESSION_INDEX_PREFIX + subject.userId, SESSION_TTL_SECONDS);
  }
  return { token, expiresIn: SESSION_TTL_SECONDS };
}

/**
 * Resolve a live session to who is behind it, or null when it is absent, expired, or belongs to an
 * account that has since been removed or suspended. Stored by hash, so a Redis dump cannot be
 * replayed as a session.
 *
 * A session minted before 7.13a holds a bare role string ('1', 'owner', 'viewer') rather than JSON.
 * Those keep working, unattributed, until they expire — an upgrade must not sign everyone out.
 */
export async function resolveSession(token: string): Promise<SessionIdentity | null> {
  if (!token) return null;
  const hash = sha256(token);
  const raw = await redis.get(SESSION_PREFIX + hash);
  if (raw === null) return null;

  let parsed: SessionValue | null = null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') parsed = v as SessionValue;
  } catch {
    parsed = null; // a pre-7.13a session: a bare role string, not JSON
  }

  // Keep lastSeenAt honest without a Redis write per request: refresh only once it is a minute
  // stale, preserving the TTL — activity must never quietly extend a session's life.
  if (parsed?.v === 2 && parsed.lastSeenAt && Date.now() - parsed.lastSeenAt > LAST_SEEN_REFRESH_MS) {
    parsed.lastSeenAt = Date.now();
    await redis.set(SESSION_PREFIX + hash, JSON.stringify(parsed), 'KEEPTTL');
  }

  if (!parsed?.uid) {
    return { userId: null, role: asRole(parsed?.role ?? raw), name: null };
  }

  const user = await prisma.adminUser.findUnique({
    where:  { id: parsed.uid },
    select: { id: true, name: true, role: true, status: true },
  });
  // The account is gone or suspended: the session dies with it, right now, rather than lingering
  // until its TTL runs out.
  if (!user || user.status !== 'active') return null;
  return { userId: user.id, role: asRole(user.role), name: user.name };
}

export async function isValidSession(token: string): Promise<boolean> {
  return (await resolveSession(token)) !== null;
}

/**
 * Is this token a live session, judged from the key-value store ALONE? (Phase A4)
 *
 * Deliberately weaker than `resolveSession`, and only for the maintenance status endpoint. That
 * endpoint exists to be answerable while a `replace` restore holds every table under ACCESS
 * EXCLUSIVE — and `resolveSession` reads `adminUser`, so using it there would block inside the
 * check, in exactly the situation the endpoint was added for.
 *
 * What is given up: "the account still exists and is active". What is kept: proof of holding an
 * unexpired session token, which is not guessable. The trade is acceptable for one read-only
 * endpoint whose entire output — that a restore is running, and how far along — is already public
 * on every proxy 503, which necessarily says "unavailable, retry in N".
 *
 * Do not reach for this anywhere else. Anything that acts on WHO is calling needs the account.
 */
export async function hasLiveSession(token: string): Promise<boolean> {
  if (!token) return false;
  return (await redis.get(SESSION_PREFIX + sha256(token))) !== null;
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const hash = sha256(token);
  // Unindex before deleting: the value names the account whose index holds this hash.
  const raw = await redis.get(SESSION_PREFIX + hash);
  if (raw) {
    try {
      const v = JSON.parse(raw) as SessionValue;
      if (v?.uid) await redis.srem(SESSION_INDEX_PREFIX + v.uid, hash);
    } catch { /* bare legacy session — nothing indexed */ }
  }
  await redis.del(SESSION_PREFIX + hash);
}

// ── Your sessions (Phase 7.13b) ───────────────────────────────────────────────

/**
 * Every live session belonging to an account, newest activity first. Index members whose
 * session has since expired are pruned as they are discovered — the set is a convenience
 * index, never the authority; the session key itself is.
 */
export async function listSessions(userId: string, currentToken?: string): Promise<SessionView[]> {
  const indexKey = SESSION_INDEX_PREFIX + userId;
  const hashes = await redis.smembers(indexKey);
  if (hashes.length === 0) return [];

  const currentHash = currentToken ? sha256(currentToken) : null;
  const values = await redis.mget(hashes.map((h) => SESSION_PREFIX + h));

  const out: SessionView[] = [];
  const dead: string[] = [];
  for (let i = 0; i < hashes.length; i++) {
    const raw = values[i];
    if (raw === null) { dead.push(hashes[i]); continue; }
    let v: SessionValue | null = null;
    try { v = JSON.parse(raw) as SessionValue; } catch { /* not one of ours */ }
    // A session in this index that belongs to someone else has been tampered with — skip it.
    if (!v || v.uid !== userId) { dead.push(hashes[i]); continue; }
    out.push({
      id: hashes[i],
      ua: v.ua ?? null,
      ip: v.ip ?? null,
      createdAt: v.createdAt ?? null,
      lastSeenAt: v.lastSeenAt ?? null,
      current: hashes[i] === currentHash,
    });
  }
  if (dead.length) await redis.srem(indexKey, ...dead);

  return out.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/**
 * End one of the CALLER'S OWN sessions by its id. Membership in the caller's index is the
 * ownership check: an id that is not theirs — however obtained — removes nothing.
 */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const owned = await redis.sismember(SESSION_INDEX_PREFIX + userId, sessionId);
  if (!owned) return false;
  await redis.del(SESSION_PREFIX + sessionId);
  await redis.srem(SESSION_INDEX_PREFIX + userId, sessionId);
  return true;
}

/** Sign out everywhere else: every session but the one making the request. */
export async function revokeOtherSessions(userId: string, currentToken: string): Promise<number> {
  const currentHash = sha256(currentToken);
  const sessions = await listSessions(userId, currentToken);
  let revoked = 0;
  for (const s of sessions) {
    if (s.id === currentHash) continue;
    if (await revokeSessionById(userId, s.id)) revoked++;
  }
  return revoked;
}

/** Every session an account holds, gone — the offboarding half (removal, factory reset). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const sessions = await listSessions(userId);
  let revoked = 0;
  for (const s of sessions) {
    if (await revokeSessionById(userId, s.id)) revoked++;
  }
  return revoked;
}

// ── Login ─────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; token: string; expiresIn: number; role: AdminRole; userId: string | null; name: string | null }
  | { ok: false; reason: 'locked_out'; retryAfter: number }
  | { ok: false; reason: 'totp_required' }
  | { ok: false; reason: 'suspended' }
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

export async function login(
  input: { email?: string; password: string; code?: string },
  source: string,
  userAgent?: string | null,
): Promise<LoginResult> {
  const { password, code } = input;
  // The source address doubles as the session's recorded IP — it is already the truth the
  // lockout keys on, so the sessions panel shows the same address the throttle sees.
  const meta: SessionMeta = { ua: userAgent ?? null, ip: source };
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
  const failed = async (reason: 'invalid' | 'totp_required' = 'invalid'): Promise<LoginResult> => {
    const { lockedOut, retryAfter: ra } = await fail();
    return lockedOut ? { ok: false, reason: 'locked_out', retryAfter: ra } : { ok: false, reason };
  };

  // An admin API token may be presented in place of the password, so a script (or a person holding
  // a viewer token) can obtain a dashboard session without an account. Tokens already bypass the
  // second factor by design — they are for callers that cannot present one — so this path mints a
  // session at the token's own role and does not consult TOTP. No account is behind it, which is
  // why the session carries a role rather than a uid.
  const tokenRole = await verifyAdminApiToken(password);
  if (tokenRole) {
    await clearFailedAttempts(source);
    const { token, expiresIn } = await createSession({ role: tokenRole }, meta);
    return { ok: true, token, expiresIn, role: tokenRole, userId: null, name: null };
  }

  // ── Before the gateway is claimed: Phase 6's path, unchanged ──
  // The master password signs in as owner (subject to the singleton second factor). This is what
  // makes the upgrade a non-event: an operator who has not yet claimed signs in exactly as before,
  // and is then shown the claim screen.
  if (await isUnclaimed()) {
    if (!safeEqual(password, process.env.ADMIN_PASSWORD)) return failed();

    if ((await getLegacyTotpState()).enabled) {
      if (!code) return failed('totp_required');
      const row = await prisma.adminAuth.findUnique({ where: { id: SINGLETON } });
      const bySecret = !!row?.totpSecret && verifyTotp(code, decrypt(row.totpSecret));
      // A legacy recovery code has no owner yet, so it is matched by hash alone — the per-user
      // check below cannot apply to codes minted before anyone existed to own them.
      const byRecovery = bySecret ? false : await consumeLegacyRecoveryCode(code);
      if (!bySecret && !byRecovery) return failed();
    }

    await clearFailedAttempts(source);
    const { token, expiresIn } = await createSession({ role: 'owner' }, meta);
    return { ok: true, token, expiresIn, role: 'owner', userId: null, name: null };
  }

  // ── Once claimed: an account, or nothing ──
  // The master password is deliberately not checked here. It is refused like any other wrong
  // password — including the timing, since it never reaches a comparison the reply could betray.
  const user = input.email ? await prisma.adminUser.findUnique({ where: { email: input.email.trim().toLowerCase() } }) : null;

  // The password is verified even when there is no such account, and even when the account is an
  // SSO one with no password (verifyPassword on a null digest is a guaranteed false). Skipping the
  // work would make sign-in an oracle: a fast "no" would mean the address is unknown, a slow one
  // would mean it exists — which is how you enumerate the people who administer a gateway.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !passwordOk) return failed();
  if (user.status !== 'active') {
    // Counted as a failure like any other: a suspended account's password is still a live secret,
    // and an attacker holding it must not get an unthrottled way to learn the suspension is the
    // only thing stopping them.
    await fail();
    return { ok: false, reason: 'suspended' };
  }

  if (user.totpSecret && user.totpConfirmedAt) {
    if (!code) return failed('totp_required');
    const bySecret = verifyTotp(code, decrypt(user.totpSecret));
    const byRecovery = bySecret ? false : await consumeRecoveryCode(user.id, code);
    if (!bySecret && !byRecovery) return failed();
  }

  await clearFailedAttempts(source);
  // Fire and forget: a last-seen timestamp must never fail a sign-in.
  void prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
  const { token, expiresIn } = await createSession({ userId: user.id }, meta);
  return { ok: true, token, expiresIn, role: asRole(user.role), userId: user.id, name: user.name };
}

/**
 * Spend a recovery code that predates accounts (userId is null), for the pre-claim sign-in path.
 * Kept separate from `consumeRecoveryCode` so that the per-user ownership check there stays
 * unconditional — a function that skips the check "when userId is null" would be one refactor away
 * from letting anyone's code unlock anyone's account.
 */
async function consumeLegacyRecoveryCode(code: string): Promise<boolean> {
  const normalized = (code ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const row = await prisma.adminRecoveryCode.findUnique({ where: { codeHash: sha256(normalized) } });
  if (!row || row.usedAt || row.userId !== null) return false;
  await prisma.adminRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}

// ── Admin API tokens ──────────────────────────────────────────────────────────
// Scripts and CI cannot present a second factor. They authenticate with a long-lived
// token that the operator can see and revoke, rather than with the admin password.

const TOKEN_PREFIX = 'nxa_';

export async function createAdminApiToken(
  name: string,
  role: AdminRole = 'owner',
  createdById: string | null = null,
): Promise<{ id: string; name: string; token: string; maskedKey: string; role: AdminRole }> {
  // The route validates with Zod, but this is an exported service function: enforce the same
  // bound here so a direct caller can never persist a blank or oversized name.
  const normalizedName = name.trim();
  if (normalizedName.length < 1 || normalizedName.length > 80) {
    throw new Error('Token name must be between 1 and 80 characters.');
  }
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const maskedKey = `${token.slice(0, 8)}••••${token.slice(-4)}`;
  const row = await prisma.adminApiToken.create({
    // `createdById` (7.13a) is what makes offboarding real: removing a person revokes the tokens
    // they minted. Null when a token is created by a pre-accounts or token-minted session — there
    // is genuinely nobody to attribute it to, and inventing an owner would be worse than admitting it.
    data: { name: normalizedName, tokenHash: sha256(token), maskedKey, role, createdById },
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
  const rows = await prisma.adminApiToken.findMany({
    where:   { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select:  {
      id: true, name: true, maskedKey: true, role: true, lastUsedAt: true, createdAt: true,
      createdBy: { select: { name: true } },
    },
  });
  // Flattened to a name (or null) rather than a nested object: the dashboard wants to say who made
  // a token, and a token with nobody behind it should read as exactly that.
  return rows.map(({ createdBy, ...t }) => ({ ...t, createdBy: createdBy?.name ?? null }));
}

export async function revokeAdminApiToken(id: string): Promise<void> {
  await prisma.adminApiToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}
