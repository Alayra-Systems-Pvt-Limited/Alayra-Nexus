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

// Enterprise SSO HTTP surface (Phase 6.6). Three unguarded routes carry the OIDC
// redirect handshake (they are how an unauthenticated caller obtains a credential, exactly
// like /admin/login), and two guarded routes read and write the configuration. The login
// and callback legs never expose an IdP error detail to the browser — only a stable code.
import { FastifyInstance } from 'fastify';
import { z }               from 'zod';
import * as sso            from '../../services/sso.service';
import { buildOrigin }     from '../../lib/baseUrl';
import { recordAudit }     from '../../services/audit.service';
import { adminGuard, adminOwnerGuard } from './guard';
import { AUTH_RATE_LIMIT, rateLimited } from '../../lib/routeRateLimits';

const configSchema = z.object({
  enabled:      z.boolean().default(false),
  displayName:  z.string().max(80).default('Single Sign-On'),
  issuer:       z.string().max(400).default(''),
  clientId:     z.string().max(400).default(''),
  // Empty string keeps the stored secret; a value replaces it. Never sent back to the UI.
  clientSecret: z.string().max(1000).optional(),
  scopes:       z.string().max(400).default('openid email profile'),
  roleClaim:    z.string().max(120).default(''),
  ownerValue:   z.string().max(200).default(''),
});

/** Absolute callback URL for this request's public origin — must match what the IdP has. */
function callbackUri(request: { host: string; headers: Record<string, unknown> }): string {
  const origin = buildOrigin({
    host:           request.host,
    forwardedProto: request.headers['x-forwarded-proto'] as string | undefined,
    forwardedHost:  request.headers['x-forwarded-host']  as string | undefined,
  });
  return origin + sso.SSO_CALLBACK_PATH;
}

/** Send the browser back to the login screen with a neutral, non-sensitive reason code. */
function bounce(reply: import('fastify').FastifyReply, code: string) {
  return reply.redirect(`/?sso_error=${encodeURIComponent(code)}`);
}

export default async function adminSsoRoutes(fastify: FastifyInstance) {
  // ── Unauthenticated login screen hint ─────────────────────────────
  // Reveals only whether to show the SSO button and its label — nothing sensitive, so it
  // is safe before sign-in. Everything else about the config stays behind adminGuard.
  fastify.get('/admin/sso/enabled', async (_req, reply) => {
    return reply.send(await sso.getLoginHint());
  });

  // ── Begin sign-in ─────────────────────────────────────────────────
  // Unguarded by design: it is how a caller authenticates. On any misconfiguration it
  // bounces to the login screen rather than erroring, so a disabled IdP is not a dead end.
  fastify.get('/admin/sso/login', rateLimited(AUTH_RATE_LIMIT), async (request, reply) => {
    try {
      const url = await sso.beginLogin(callbackUri(request));
      return reply.redirect(url);
    } catch (e) {
      const code = e instanceof sso.SsoError ? e.code : 'discovery_failed';
      request.log.warn({ err: e }, 'sso login start failed');
      return bounce(reply, code);
    }
  });

  // ── IdP callback ──────────────────────────────────────────────────
  // Verifies the response and, on success, returns a tiny page that stores the freshly
  // minted session token in sessionStorage (never in the URL) and continues into the app.
  fastify.get('/admin/sso/callback', rateLimited(AUTH_RATE_LIMIT), async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    if (q.error) return bounce(reply, 'verification_failed');

    try {
      const { token, role } = await sso.completeLogin(q.code ?? '', q.state ?? '');
      recordAudit({
        action: 'auth.sso.login', method: 'GET', actorRole: role, actor: 'sso',
        ip: request.ip, status: 200, detail: JSON.stringify({ outcome: 'success' }),
      });
      const payload = JSON.stringify({ token, role });
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Signing in…</title>` +
          `<body style="font-family:system-ui;background:#0b0f14;color:#e6edf3">` +
          `<p style="margin:40px">Signing you in…</p><script>` +
          `(function(){var d=${payload};try{sessionStorage.setItem('nx_token',d.token);` +
          `sessionStorage.setItem('nx_role',d.role);}catch(e){}location.replace('/');})();` +
          `</script></body>`,
        );
    } catch (e) {
      const code = e instanceof sso.SsoError ? e.code : 'verification_failed';
      request.log.warn({ err: e }, 'sso callback failed');
      recordAudit({
        action: 'auth.sso.login', method: 'GET', actorRole: 'system', actor: 'sso',
        ip: request.ip, status: 401, detail: JSON.stringify({ outcome: code }),
      });
      return bounce(reply, code);
    }
  });

  // ── Configuration (read: any admin; write: owner only) ────────────
  fastify.get('/admin/sso/config', adminGuard, async (_req, reply) => {
    return reply.send(await sso.getPublicConfig());
  });

  fastify.put('/admin/sso/config', adminOwnerGuard, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid SSO configuration.' });
    try {
      await sso.saveConfig(parsed.data);
    } catch (e) {
      if (e instanceof sso.SsoError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return reply.send(await sso.getPublicConfig());
  });
}
