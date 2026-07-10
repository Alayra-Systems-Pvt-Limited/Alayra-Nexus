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
import { FastifyInstance } from 'fastify';
import { z }              from 'zod';
import * as auth          from '../../services/adminAuth.service';
import * as metrics       from '../../lib/metrics';
import { adminGuard }     from './guard';

const loginSchema = z.object({
  password: z.string().min(1),
  // A TOTP code or a recovery code. Absent until a second factor is enrolled.
  code:     z.string().max(64).optional(),
});

const codeSchema  = z.object({ code: z.string().min(1).max(64) });
const tokenSchema = z.object({ name: z.string().min(1).max(80) });

function bearer(req: { headers: Record<string, unknown> }): string {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : '';
}

export default async function adminAuthRoutes(fastify: FastifyInstance) {
  // ── Sign in ───────────────────────────────────────────────────────
  // Deliberately unguarded — it is how a caller obtains a credential. The server's
  // abuse guard covers it, and adminAuth adds a per-source lockout on top.
  fastify.post('/admin/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      metrics.adminLogin('invalid');
      return reply.code(400).send({ error: 'password is required' });
    }

    const result = await auth.login(parsed.data.password, parsed.data.code, request.ip);

    if (result.ok) {
      metrics.adminLogin('success');
      return reply.send({ token: result.token, expiresIn: result.expiresIn });
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
    return reply.send({ success: true });
  });

  // ── Second factor ─────────────────────────────────────────────────

  fastify.get('/admin/auth/status', adminGuard, async (_req, reply) => {
    const state = await auth.getTotpState();
    return reply.send({
      twoFactorEnabled:        state.enabled,
      enrolmentPending:        state.pending,
      recoveryCodesRemaining:  state.enabled ? await auth.countUnusedRecoveryCodes() : 0,
      sessionTtlSeconds:       auth.SESSION_TTL_SECONDS,
      maxLoginAttempts:        auth.MAX_LOGIN_ATTEMPTS,
      lockoutSeconds:          auth.LOCKOUT_SECONDS,
    });
  });

  // Mints a secret and returns it once. Enforcement does not change until the secret
  // is confirmed, so an abandoned enrolment cannot lock anyone out.
  fastify.post('/admin/auth/totp/enrol', adminGuard, async (_req, reply) => {
    if (await auth.isTwoFactorEnabled()) {
      return reply.code(409).send({ error: 'Two-factor authentication is already enabled. Disable it first to re-enrol.' });
    }
    const { secret, otpauthUri } = await auth.beginTotpEnrolment();
    return reply.send({ secret, otpauthUri });
  });

  fastify.post('/admin/auth/totp/confirm', adminGuard, async (request, reply) => {
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });

    const { ok, recoveryCodes } = await auth.confirmTotp(parsed.data.code);
    if (!ok) return reply.code(400).send({ error: 'That code is not valid. Check your device clock and try again.' });

    // Shown exactly once. They are stored only as hashes.
    return reply.send({ success: true, recoveryCodes });
  });

  fastify.post('/admin/auth/totp/disable', adminGuard, async (request, reply) => {
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });

    const ok = await auth.disableTotp(parsed.data.code);
    if (!ok) return reply.code(400).send({ error: 'A valid authenticator or recovery code is required to disable two-factor authentication.' });
    return reply.send({ success: true });
  });

  fastify.post('/admin/auth/recovery-codes', adminGuard, async (request, reply) => {
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code is required' });
    if (!await auth.isTwoFactorEnabled()) return reply.code(409).send({ error: 'Two-factor authentication is not enabled.' });

    // Re-prove possession before reissuing: a hijacked session must not be able to
    // mint itself a permanent bypass of the second factor.
    if (!await auth.verifyTotpCode(parsed.data.code)) {
      return reply.code(400).send({ error: 'That code is not valid.' });
    }
    const recoveryCodes = await auth.regenerateRecoveryCodes();
    return reply.send({ recoveryCodes });
  });

  // ── Admin API tokens ──────────────────────────────────────────────

  fastify.get('/admin/tokens', adminGuard, async (_req, reply) => {
    return reply.send({ tokens: await auth.listAdminApiTokens() });
  });

  fastify.post('/admin/tokens', adminGuard, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'name is required' });
    const token = await auth.createAdminApiToken(parsed.data.name);
    return reply.code(201).send({ token }); // plaintext returned once
  });

  fastify.delete('/admin/tokens/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await auth.revokeAdminApiToken(id);
    return reply.send({ success: true });
  });
}
