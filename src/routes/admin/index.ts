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

import { FastifyInstance } from 'fastify';

import adminAuthRoutes      from './auth.routes';
import adminSsoRoutes       from './sso.routes';
import adminSystemRoutes    from './system.routes';
import adminOverviewRoutes  from './overview.routes';
import adminNexusRoutes     from './nexus.routes';
import adminSettingsRoutes  from './settings.routes';
import adminCacheRoutes     from './cache.routes';
import adminProvidersRoutes from './providers.routes';
import adminKeysRoutes      from './keys.routes';
import adminModelsRoutes    from './models.routes';
import adminAnalyticsRoutes from './analytics.routes';
import adminTeamsRoutes     from './teams.routes';
import adminAuditRoutes     from './audit.routes';
import adminNotificationsRoutes from './notifications.routes';
import adminBrandingRoutes  from './branding.routes';
import { recordAudit }      from '../../services/audit.service';
import { deriveAction, shouldAutoAudit } from '../../lib/audit';

/**
 * The admin API, grouped by resource. Each sub-router declares its own absolute
 * `/admin/...` paths and applies `adminGuard` per route, so registration order is
 * irrelevant and no prefix is inherited.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  // Audit hook (Phase 6.7): one place records every state-changing admin action, so a route
  // added later is covered without anyone remembering to log it — the same principle as the
  // guard. Encapsulated to this plugin, so only /admin traffic is audited, never the proxy.
  // Reads the role that verifyAdminPassword already attached; auth/SSO routes are recorded by
  // their own handlers (with the outcome the hook cannot see) and skipped here. Wrapped so an
  // audit failure can never disturb the response that already completed.
  fastify.addHook('onResponse', async (request, reply) => {
    try {
      const url = request.routeOptions?.url ?? request.url;
      if (!shouldAutoAudit(url, request.method, reply.statusCode)) return;
      const params = (request.params ?? {}) as Record<string, string>;
      recordAudit({
        action:    deriveAction(request.method, url),
        method:    request.method,
        actorRole: request.adminRole ?? 'system',
        target:    params.id ?? params.slug ?? null,
        ip:        request.ip,
        status:    reply.statusCode,
      });
    } catch { /* auditing must never break a response */ }
  });

  // Auth first: /admin/login and the SSO handshake routes are the ones here not behind
  // adminGuard — they are how a caller obtains a credential.
  await fastify.register(adminAuthRoutes);
  await fastify.register(adminSsoRoutes);
  await fastify.register(adminSystemRoutes);
  await fastify.register(adminOverviewRoutes);
  await fastify.register(adminNexusRoutes);
  await fastify.register(adminSettingsRoutes);
  await fastify.register(adminCacheRoutes);
  await fastify.register(adminProvidersRoutes);
  await fastify.register(adminKeysRoutes);
  await fastify.register(adminModelsRoutes);
  await fastify.register(adminAnalyticsRoutes);
  await fastify.register(adminTeamsRoutes);
  await fastify.register(adminAuditRoutes);
  await fastify.register(adminNotificationsRoutes);
  await fastify.register(adminBrandingRoutes);
}
