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

// Dashboard config, health, API-key management, routing status, cache bust.
import { FastifyInstance }      from 'fastify';
import { REGISTRY_CACHE_KEY }  from '../../lib/registryCacheKey';
import { buildBaseUrl }        from '../../lib/baseUrl';
import { getSetting, setSetting } from '../../services/settings.service';
import { prisma }              from '../../lib/prisma';
import { randomUUID } from 'crypto';
import { redis }               from '../../lib/redis';
import { adminGuard, adminOwnerGuard } from './guard';
import { ADMIN_WRITE_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';

export default async function adminSystemRoutes(fastify: FastifyInstance) {
  // ── Dashboard config (auto-detects base URL from request) ────────

  fastify.get('/admin/config', adminGuard, async (request, reply) => {
    const apiKey    = await getSetting('NEXUS_API_KEY');
    const providers = await prisma.nexusProvider.count();
    const baseUrl   = buildBaseUrl({
      host:           request.host, // NOT request.hostname — v5 strips the port
      forwardedProto: request.headers['x-forwarded-proto'],
      forwardedHost:  request.headers['x-forwarded-host'],
    });
    return reply.send({ baseUrl, nexusApiKey: apiKey, isFirstRun: providers === 0 });
  });

  // ── Setup / health ────────────────────────────────────────────────

  fastify.get('/admin/status', adminGuard, async (request, reply) => {
    const apiKey = await getSetting('NEXUS_API_KEY');
    const providers = await prisma.nexusProvider.count();
    const keys      = await prisma.nexusKey.count({ where: { status: 'active' } });
    // `role` lets the dashboard restore its read-only state on reload (Phase 6.5).
    return reply.send({ ok: true, providers, activeKeys: keys, apiKeySet: !!apiKey, role: request.adminRole ?? 'owner' });
  });

  // ── API key management ────────────────────────────────────────────

  fastify.get('/admin/api-key', adminGuard, async (_req, reply) => {
    const key = await getSetting('NEXUS_API_KEY');
    return reply.send({ key });
  });

  fastify.post('/admin/api-key/regenerate', adminOwnerGuard, async (_req, reply) => {
    const newKey = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await setSetting('NEXUS_API_KEY', newKey);
    return reply.send({ key: newKey });
  });

  // ── Routing status ────────────────────────────────────────────────

  fastify.get('/admin/routing/status', adminGuard, async (_req, reply) => {
    const providers = await prisma.nexusProvider.findMany({
      where:   { isActive: true },
      include: { keys: true },
      orderBy: { createdAt: 'asc' },
    });

    const now = new Date();
    const tiers = ['premium', 'standard', 'fast'];
    // Counts are per provider. They were previously summed across the whole tier and
    // then stamped onto every provider in it, so a tier holding two providers showed
    // each of them the tier's combined total — and the dashboard renders this value
    // per provider.
    const isUsable = (k: { status: string; coolingUntil: Date | null }) =>
      k.status === 'active' && (!k.coolingUntil || k.coolingUntil <= now);

    const status = tiers.map(tier => ({
      tier,
      providers: providers
        .filter(p => p.tier === tier)
        .map(p => ({
          id:             p.id,
          name:           p.name,
          preferredModel: p.preferredModel,
          totalKeys:      p.keys.length,
          activeKeys:     p.keys.filter(isUsable).length,
        })),
    }));

    return reply.send({ tiers: status });
  });

  // ── Nexus summary ─────────────────────────────────────────────────

  fastify.get('/admin/nexus/summary', adminGuard, async (_req, reply) => {
    const now       = new Date();
    const providers = await prisma.nexusProvider.count({ where: { isActive: true } });
    const allKeys   = await prisma.nexusKey.findMany({ select: { status: true, coolingUntil: true } });
    const active    = allKeys.filter(k => k.status === 'active' && (!k.coolingUntil || k.coolingUntil <= now)).length;
    const cooling   = allKeys.filter(k => k.status === 'cooling' || (k.coolingUntil && k.coolingUntil > now)).length;
    const banned    = allKeys.filter(k => k.status === 'banned').length;
    return reply.send({ providers, active, cooling, banned, total: allKeys.length });
  });

  // ── Cache bust ────────────────────────────────────────────────────

  fastify.post('/admin/cache/flush', withRateLimit(adminOwnerGuard, ADMIN_WRITE_RATE_LIMIT), async (_req, reply) => {
    await redis.del(REGISTRY_CACHE_KEY);
    return reply.send({ success: true });
  });
}
