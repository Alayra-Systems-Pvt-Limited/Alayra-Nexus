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

// Admin sign-in, second factor, and the API tokens that scripts use instead.
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z }              from 'zod';
import * as auth          from '../../services/adminAuth.service';
import * as metrics       from '../../lib/metrics';
import { recordAudit }    from '../../services/audit.service';
import { adminGuard, adminOwnerGuard } from './guard';
import { AUTH_RATE_LIMIT, rateLimited, withRateLimit } from '../../lib/routeRateLimits';
import { getClaimStatus, claimGateway, factoryReset, RESET_CONFIRM_PHRASE } from '../../services/firstRun.service';
import { safeEqual } from '../../lib/timingSafe';
import { changeOwnPassword, regenerateRecoveryKey, resetPasswordWithRecoveryKey, getUser, AdminUserError } from '../../services/adminUsers.service';
import { describeUserAgent } from '../../lib/userAgent';

const loginSchema = z.object({
  // Optional, because a gateway that has not been claimed yet still signs in exactly as it did in
  // Phase 6: the master password alone, no account, no email. Required in practice once claimed —
  // a missing email simply finds no account and fails like any other wrong credential.
  email:    z.string().max(200).optional(),
  password: z.string().min(1),
  // A TOTP code or a recovery code. Absent until a second factor is enrolled.
  code:     z.string().max(64).optional(),
});

const codeSchema  = z.object({ code: z.string().min(1).max(64) });
const tokenSchema = z.object({
  name: z.string().min(1).max(80),
  // Access level for the minted token (Phase 6.5). Defaults to owner so existing callers
  // and integrations are unchanged; a viewer token can read but never mutate.
  role: z.enum(['owner', 'admin', 'viewer']).default('owner'),
});

function bearer(req: { headers: Record<string, unknown> }): string {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : '';
}

/**
 * The account behind the request, or null after answering for us.
 *
 * A session minted from an admin API token, or one that predates accounts, has no person behind it.
 * Those callers can read and operate the gateway, but there is nothing to enrol a second factor on
 * or change a password for — so say that plainly rather than fail somewhere deeper with a null id.
 */
function accountOf(request: FastifyRequest, reply: FastifyReply): string | null {
  if (request.adminUserId) return request.adminUserId;
  reply.code(400).send({
    error: 'This session is not tied to an account, so there is nothing here to change. Sign in with your email and password.',
  });
  return null;
}

export default async function adminAuthRoutes(fastify: FastifyInstance) {
  // ── Sign in ───────────────────────────────────────────────────────
  // Deliberately unguarded — it is how a caller obtains a credential. The global abuse guard covers
  // it, adminAuth adds a per-source lockout, and this per-route limit caps sign-in attempts tightly
  // (well above any human retry rate) so a distributed guessing attempt is throttled too.
  fastify.post('/admin/login', rateLimited(AUTH_RATE_LIMIT), async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      metrics.adminLogin('invalid');
      return reply.code(400).send({ error: 'password is required' });
    }

    const result = await auth.login(parsed.data, request.ip, request.headers['user-agent']);

    // Record the sign-in outcome (never the credential). A failed or locked-out attempt is as
    // security-relevant as a success, so every branch is logged with its outcome.
    const outcome = result.ok ? 'success' : result.reason;
    recordAudit({
      action:    'auth.login',
      method:    'POST',
      actorRole: result.ok ? result.role : 'system',
      actor:     'password',
      // Who signed in (Phase 7.13a). Null on a failure by design: attributing a failed attempt to
      // an account would let the log assert an identity nobody proved.
      actorId:   result.ok ? result.userId : null,
      actorName: result.ok ? result.name : null,
      ip:        request.ip,
      status:    result.ok ? 200 : result.reason === 'locked_out' ? 429 : 401,
      detail:    JSON.stringify({ outcome }),
    });

    if (result.ok) {
      metrics.adminLogin('success');
      return reply.send({
        token: result.token, expiresIn: result.expiresIn, role: result.role,
        user: result.userId ? { id: result.userId, name: result.name } : null,
      });
    }

    if (result.reason === 'suspended') {
      metrics.adminLogin('invalid');
      return reply.code(403).send({ error: 'This account is suspended. Contact an owner of this gateway.' });
    }

    if (result.reason === 'locked_out') {
      metrics.adminLogin('locked_out');
      return reply
        .code(429)
        .header('Retry-After', String(result.retryAfter))
        .send({ error: `Too many failed sign-in attempts. Try again in ${result.retryAfter}s.`, retryAfter: result.retryAfter });
    }

    if (result.reason === 'totp_required') {
      // Reached only with a correct password, so this discloses nothing a caller who
      // already authenticated does not know.
      metrics.adminLogin('totp_required');
      return reply.code(401).send({ error: 'Authenticator code required.', totpRequired: true });
    }

    metrics.adminLogin('invalid');
    return reply.code(401).send({ error: 'Invalid credentials.' });
  });

  fastify.post('/admin/logout', adminGuard, async (request, reply) => {
    await auth.destroySession(bearer(request));
    recordAudit({
      action: 'auth.logout', method: 'POST',
      actorRole: request.adminRole ?? 'system', ip: request.ip, status: 200,
    });
    return reply.send({ success: true });
  });

  // ── Second factor ─────────────────────────────────────────────────
  //
  // Every route here is `adminGuard`, not `adminOwnerGuard`, and that is a deliberate change from
  // Phase 6 (7.13a). The second factor used to be the gateway's — one secret, owned by whoever held
  // the password — so gating it on owner made sense. It is a person's now, and a viewer securing
  // their own account is not an owner-level act. Each route operates strictly on the caller's own
  // account: there is no user id in any of these paths for someone to pass someone else's.

  fastify.get('/admin/auth/status', adminGuard, async (request, reply) => {
    const state = request.adminUserId
      ? await auth.getTotpState(request.adminUserId)
      : { enabled: false, pending: false };
    return reply.send({
      twoFactorEnabled:        state.enabled,
      enrolmentPending:        state.pending,
      recoveryCodesRemaining:  state.enabled && request.adminUserId ? await auth.countUnusedRecoveryCodes(request.adminUserId) : 0,
      // False for a session with no account behind it, so the dashboard can explain why the second
      // factor cannot be set up here instead of showing a button that always fails.
      hasAccount:              !!request.adminUserId,
      sessionTtlSeconds:       auth.SESSION_TTL_SECONDS,
      maxLoginAttempts:        auth.MAX_LOGIN_ATTEMPTS,
      lockoutSeconds:          auth.LOCKOUT_SECONDS,
    });
  });

  // Mints a secret and returns it once. Enforcement does not change until the secret
  // is confirmed, so an abandoned enrolment cannot lock anyone out.
  fastify.post('/admin/auth/totp/enrol', adminGuard, async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;

    if ((await auth.getTotpState(userId)).enabled) {
      return reply.code(409).send({ error: 'Two-factor authentication is already enabled. Disable it first to re-enrol.' });
    }
    const account = await getUser(userId);
    // Label the entry in the authenticator app with the person's email, not a generic "admin" —
    // several people may now hold codes for the same gateway.
    const { secret, otpauthUri } = await auth.beginTotpEnrolment(userId, account?.email ?? 'admin');
    return reply.send({ secret, otpauthUri });
  });

  fastify.post('/admin/auth/totp/confirm', withRateLimit(adminGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });

    const { ok, recoveryCodes } = await auth.confirmTotp(userId, parsed.data.code);
    if (!ok) return reply.code(400).send({ error: 'That code is not valid. Check your device clock and try again.' });

    // Recorded by the automatic hook (`auth.totp.confirm`), which now carries the actor.
    // Shown exactly once. They are stored only as hashes.
    return reply.send({ success: true, recoveryCodes });
  });

  fastify.post('/admin/auth/totp/disable', withRateLimit(adminGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });

    const ok = await auth.disableTotp(userId, parsed.data.code);
    if (!ok) return reply.code(400).send({ error: 'A valid authenticator or recovery code is required to disable two-factor authentication.' });

    // Recorded by the automatic hook (`auth.totp.disable`), which now carries the actor.
    return reply.send({ success: true });
  });

  fastify.post('/admin/auth/recovery-codes', withRateLimit(adminGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });
    if (!(await auth.getTotpState(userId)).enabled) {
      return reply.code(409).send({ error: 'Two-factor authentication is not enabled.' });
    }

    // Re-prove possession before reissuing: a hijacked session must not be able to
    // mint itself a permanent bypass of the second factor.
    if (!await auth.verifyTotpCode(userId, parsed.data.code)) {
      return reply.code(400).send({ error: 'That code is not valid.' });
    }
    const recoveryCodes = await auth.regenerateRecoveryCodes(userId);
    return reply.send({ recoveryCodes });
  });

  // ── First run: claiming the gateway (Phase 7.13a) ─────────────────
  //
  // Both routes are deliberately unguarded — there is no credential to present on a gateway with no
  // accounts. What stands in for one is ADMIN_PASSWORD, which lives in the deployer's .env: proof
  // that you are the person who installed this, not merely someone who found the port first.

  fastify.get('/admin/setup/status', rateLimited(AUTH_RATE_LIMIT), async (_req, reply) => {
    // Says only whether the gateway has been claimed and whether an existing authenticator will be
    // carried over. Nothing here helps an attacker: an unclaimed gateway announces itself the moment
    // it serves a sign-in page, and the claim still needs the environment secret.
    return reply.send(await getClaimStatus());
  });

  fastify.post('/admin/setup/claim', rateLimited(AUTH_RATE_LIMIT), async (request, reply) => {
    const schema = z.object({
      masterPassword: z.string().min(1),
      name:           z.string().min(1).max(80),
      email:          z.string().min(3).max(200),
      password:       z.string().min(1).max(200),
      // Optional so a scripted claim still works and an upgrade is never blocked by it (C6).
      backupPassphrase: z.string().min(12).max(200).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Fill in every field to create your account.' });

    try {
      const result = await claimGateway(parsed.data);
      // The first entry in the trail that names a person — and the record of when this gateway
      // stopped belonging to whoever held the password.
      recordAudit({
        action: 'admin.claim', method: 'POST', actorRole: 'owner', actor: 'password',
        actorId: result.user.id, actorName: result.user.name, ip: request.ip, status: 200,
        detail: JSON.stringify({
          twoFactorCarriedOver: result.twoFactorCarriedOver,
          // Recorded because "were this gateway's backups ever protected by a key the server cannot
          // open" is a question an auditor will ask, and the answer is decided exactly here.
          backupRecoveryKey: result.recoveryKeySet,
        }),
      });
      // Signed in immediately: making someone create an account and then type the password they
      // just chose is ceremony, not security.
      const session = await auth.createSession(
        { userId: result.user.id },
        { ua: request.headers['user-agent'], ip: request.ip },
      );
      return reply.send({
        user: result.user,
        recoveryKey: result.recoveryKey,
        twoFactorCarriedOver: result.twoFactorCarriedOver,
        // For the Recovery Kit, and returned only to a caller who has already proved they hold the
        // environment this came from. Never cached or stored by an intermediary on the way.
        masterEncryptionKey: result.masterEncryptionKey,
        backupRecoveryKeySet: result.recoveryKeySet,
        token: session.token,
        expiresIn: session.expiresIn,
        role: result.user.role,
      });
    } catch (e) {
      if (e instanceof AdminUserError) {
        recordAudit({
          action: 'admin.claim', method: 'POST', actorRole: 'system', actor: 'password',
          ip: request.ip, status: e.status, detail: JSON.stringify({ outcome: 'refused' }),
        });
        return reply.code(e.status).send({ error: e.message });
      }
      throw e;
    }
  });

  // ── Factory reset (Phase 7.13b) ───────────────────────────────────
  //
  // Three proofs, deliberately of different kinds: an OWNER session (you run this gateway),
  // the MASTER PASSWORD from the server's environment (you installed it — the same proof the
  // claim demands, because un-claiming is claiming's mirror), and the TYPED PHRASE (you are
  // doing this on purpose, not autocompleting a form). Refusals are audited; success cannot
  // be — it empties the audit table itself — so the service logs to stdout and says so.
  fastify.post('/admin/setup/reset', withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const parsed = z.object({
      masterPassword: z.string().min(1),
      confirm:        z.string().min(1),
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'The master password and the confirmation phrase are both required.' });
    }

    if (parsed.data.confirm !== RESET_CONFIRM_PHRASE) {
      return reply.code(400).send({ error: `Type the phrase exactly: ${RESET_CONFIRM_PHRASE}` });
    }

    if (!safeEqual(parsed.data.masterPassword, process.env.ADMIN_PASSWORD)) {
      recordAudit({
        action: 'admin.reset', method: 'POST', actorRole: request.adminRole ?? 'system',
        actorId: request.adminUserId ?? null, actorName: request.adminUserName ?? null,
        ip: request.ip, status: 401, detail: JSON.stringify({ outcome: 'refused_master_password' }),
      });
      return reply.code(401).send({ error: 'That is not the administrator password from your server’s environment.' });
    }

    const { tablesCleared, redisKeysCleared } = await factoryReset();
    return reply.send({ success: true, tablesCleared, redisKeysCleared });
  });

  // ── Your own account (Phase 7.13a) ────────────────────────────────

  fastify.get('/admin/me', adminGuard, async (request, reply) => {
    const account = request.adminUserId ? await getUser(request.adminUserId) : null;
    // A token-minted or pre-accounts session has a role but no person. Reporting the role with a
    // null account is the honest answer, and lets the dashboard say so rather than invent a name.
    return reply.send({ account, role: request.adminRole ?? 'viewer' });
  });

  // ── Your sessions (Phase 7.13b) ───────────────────────────────────
  //
  // Every route here operates strictly on the CALLER'S OWN sessions — there is no user id in
  // any path. An owner ends someone else's access through suspend/remove on the People page,
  // which already kills sessions on the next request; these exist so a person can see where
  // they themselves are signed in and end a session they do not recognise.

  fastify.get('/admin/me/sessions', adminGuard, async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const sessions = await auth.listSessions(userId, bearer(request));
    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        // The phrase a person recognises ("Chrome on Windows"), with the raw string alongside
        // for when coarse is not enough. Descriptive only — any client can claim any agent.
        browser: describeUserAgent(s.ua),
        userAgent: s.ua,
        ip: s.ip,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.current,
      })),
    });
  });

  fastify.delete('/admin/me/sessions/:id', adminGuard, async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const { id } = request.params as { id: string };
    // Ownership is checked against the caller's own index — an id belonging to anyone else,
    // however obtained, revokes nothing and answers the same as one that never existed.
    const ok = await auth.revokeSessionById(userId, id);
    if (!ok) return reply.code(404).send({ error: 'No such session.' });
    return reply.send({ success: true });
  });

  fastify.post('/admin/me/sessions/revoke-others', adminGuard, async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const revoked = await auth.revokeOtherSessions(userId, bearer(request));
    return reply.send({ success: true, revoked });
  });

  fastify.post('/admin/me/password', withRateLimit(adminGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    const schema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your current and new password.' });

    try {
      await changeOwnPassword(userId, parsed.data.currentPassword, parsed.data.newPassword);
      recordAudit({
        action: 'auth.password.change', method: 'POST', actorRole: request.adminRole ?? 'system',
        actorId: userId, actorName: request.adminUserName ?? null, ip: request.ip, status: 200,
      });
      return reply.send({ success: true });
    } catch (e) {
      if (e instanceof AdminUserError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  fastify.post('/admin/me/recovery-key', withRateLimit(adminGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const userId = accountOf(request, reply);
    if (!userId) return reply;
    try {
      const recoveryKey = await regenerateRecoveryKey(userId);
      return reply.send({ recoveryKey }); // shown once; stored only as a hash
    } catch (e) {
      if (e instanceof AdminUserError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  // Unguarded by necessity: the whole point is that you cannot sign in. The recovery key itself is
  // the credential — 128 bits, single use, and rate-limited here on top.
  fastify.post('/admin/auth/recover', rateLimited(AUTH_RATE_LIMIT), async (request, reply) => {
    const schema = z.object({
      email:       z.string().min(3).max(200),
      recoveryKey: z.string().min(1).max(100),
      newPassword: z.string().min(1).max(200),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your email, recovery key, and a new password.' });

    try {
      const replacement = await resetPasswordWithRecoveryKey(parsed.data.email, parsed.data.recoveryKey, parsed.data.newPassword);
      recordAudit({
        action: 'auth.password.recover', method: 'POST', actorRole: 'system', actor: 'recovery-key',
        ip: request.ip, status: 200, detail: JSON.stringify({ email: parsed.data.email }),
      });
      // A new key, because the old one is spent. Shown once, exactly like the first.
      return reply.send({ success: true, recoveryKey: replacement });
    } catch (e) {
      if (e instanceof AdminUserError) {
        recordAudit({
          action: 'auth.password.recover', method: 'POST', actorRole: 'system', actor: 'recovery-key',
          ip: request.ip, status: e.status, detail: JSON.stringify({ outcome: 'refused' }),
        });
        return reply.code(e.status).send({ error: e.message });
      }
      throw e;
    }
  });

  // ── Admin API tokens ──────────────────────────────────────────────

  fastify.get('/admin/tokens', adminGuard, async (_req, reply) => {
    return reply.send({ tokens: await auth.listAdminApiTokens() });
  });

  fastify.post('/admin/tokens', adminOwnerGuard, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'name is required' });
    // Attributed to whoever minted it (7.13a) — which is what makes removing them revoke it.
    // Not audited here: the automatic hook in index.ts already records this as `tokens.create`,
    // and now carries the actor, so an explicit entry would only be a duplicate.
    const token = await auth.createAdminApiToken(parsed.data.name, parsed.data.role, request.adminUserId ?? null);
    return reply.code(201).send({ token }); // plaintext returned once
  });

  fastify.delete('/admin/tokens/:id', adminOwnerGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await auth.revokeAdminApiToken(id);
    return reply.send({ success: true });
  });
}
