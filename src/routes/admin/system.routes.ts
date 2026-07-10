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
import { getSetting, setSetting } from '../../services/settings.service';
import { prisma }              from '../../lib/prisma';
import { randomUUID } from 'crypto';
import { redis }               from '../../lib/redis';
import { providerDefaultUrl } from '../../services/nexus.service';
import { adminGuard }           from './guard';

export default async function adminSystemRoutes(fastify: FastifyInstance) {
  // ── Dashboard config (auto-detects base URL from request) ────────

  fastify.get('/admin/config', adminGuard, async (request, reply) => {
    const apiKey    = await getSetting('NEXUS_API_KEY');
    const providers = await prisma.nexusProvider.count();
    const proto     = (request.headers['x-forwarded-proto'] as string) ?? 'http';
    const host      = (request.headers['x-forwarded-host'] as string) ?? request.hostname;
    const baseUrl   = `${proto}://${host}/v1`;
    return reply.send({ baseUrl, nexusApiKey: apiKey, isFirstRun: providers === 0 });
  });

  // ── Setup / health ────────────────────────────────────────────────

  fastify.get('/admin/status', adminGuard, async (_req, reply) => {
    const apiKey = await getSetting('NEXUS_API_KEY');
    const providers = await prisma.nexusProvider.count();
    const keys      = await prisma.nexusKey.count({ where: { status: 'active' } });
    return reply.send({ ok: true, providers, activeKeys: keys, apiKeySet: !!apiKey });
  });

  // ── API key management ────────────────────────────────────────────

  fastify.get('/admin/api-key', adminGuard, async (_req, reply) => {
    const key = await getSetting('NEXUS_API_KEY');
    return reply.send({ key });
  });

  fastify.post('/admin/api-key/regenerate', adminGuard, async (_req, reply) => {
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
    const status = tiers.map(tier => {
      const tierProviders = providers.filter(p => p.tier === tier);
      const totalKeys     = tierProviders.flatMap(p => p.keys).length;
      const activeKeys    = tierProviders.flatMap(p => p.keys).filter(k =>
        k.status === 'active' && (!k.coolingUntil || k.coolingUntil <= now)
      ).length;
      return {
        tier,
        providers: tierProviders.map(p => ({
          id:             p.id,
          name:           p.name,
          preferredModel: p.preferredModel,
          totalKeys,
          activeKeys,
        })),
      };
    });

    const defaultBaseUrl = providerDefaultUrl;
    void defaultBaseUrl;
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

  fastify.post('/admin/cache/flush', adminGuard, async (_req, reply) => {
    await redis.del(REGISTRY_CACHE_KEY);
    return reply.send({ success: true });
  });
}
