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

import { FastifyInstance }      from 'fastify';
import { z }                   from 'zod';
import { randomUUID }          from 'crypto';
import { verifyAdminPassword } from '../middleware/auth.middleware';
import { prisma }              from '../lib/prisma';
import { encrypt, decrypt, maskKey } from '../lib/encryption';
import { createHash, randomBytes } from 'crypto';
import { getSetting, setSetting } from '../services/settings.service';
import { getModelRegistry, updateModelRegistry } from '../services/model.service';
import { getUsageSummary, getUsageByTeamKey, getTimeSeriesByTeam, getTimeSeriesByModel } from '../services/token.service';
import { testKey, banKey, coolKey, validateProviderCredentials, validateModel, providerDefaultUrl } from '../services/nexus.service';
import { onSuccess as breakerReset } from '../lib/breaker';
import { assertSafeUrl }         from '../lib/url';
import { getSsrfPolicy, getSsrfConfig, setSsrfConfig } from '../services/ssrf.service';
import { getGuardrailConfigForUI, setGuardrailConfig } from '../services/guardrails.service';
import { getRoutingConfigForUI, setCostWeight } from '../services/routing.service';
import { getCurrentSpend, type BudgetPeriod } from '../services/budget.service';
import { getCacheConfigForUI, setCacheConfig } from '../services/cache.service';
import { redis }               from '../lib/redis';
import { REGISTRY_CACHE_KEY }  from '../lib/registryCacheKey';

const adminGuard = { preHandler: [verifyAdminPassword] };

export default async function adminRoutes(fastify: FastifyInstance) {

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

  // ── SSRF / network security ───────────────────────────────────────

  fastify.get('/admin/settings/ssrf', adminGuard, async (_req, reply) => {
    return reply.send(await getSsrfConfig());
  });

  const ssrfSchema = z.object({
    allowPrivate: z.boolean(),
    // Each entry is a bare host or host:port — no scheme, path, or spaces.
    allowList:    z.array(z.string().regex(/^[a-z0-9.:_-]+$/i, 'Use host or host:port only')).max(50),
  });

  fastify.put('/admin/settings/ssrf', adminGuard, async (request, reply) => {
    const body = ssrfSchema.parse(request.body);
    await setSsrfConfig(body.allowPrivate, body.allowList);
    return reply.send(await getSsrfConfig());
  });

  // ── Guardrails / content filtering ────────────────────────────────

  fastify.get('/admin/settings/guardrails', adminGuard, async (_req, reply) => {
    return reply.send(await getGuardrailConfigForUI());
  });

  const guardrailSchema = z.object({
    enabled:      z.boolean(),
    bufferedSafe: z.boolean(),
    rules: z.array(z.object({
      name:        z.string().min(1).max(60),
      pattern:     z.string().min(1).max(2000),
      flags:       z.string().max(10).optional(),
      action:      z.enum(['block', 'redact']),
      appliesTo:   z.enum(['input', 'output', 'both']).optional(),
      replacement: z.string().max(200).optional(),
    })).max(100),
  });

  fastify.put('/admin/settings/guardrails', adminGuard, async (request, reply) => {
    const body = guardrailSchema.parse(request.body);
    // Reject rules whose regex will not compile, so a bad pattern is caught at
    // save time rather than silently skipped on the request path.
    for (const r of body.rules) {
      try { new RegExp(r.pattern, r.flags ?? 'gi'); }
      catch { return reply.code(400).send({ error: `Invalid regex in rule "${r.name}": ${r.pattern}` }); }
    }
    await setGuardrailConfig(body.enabled, body.bufferedSafe, body.rules);
    return reply.send(await getGuardrailConfigForUI());
  });

  // ── Routing (cost-aware) ──────────────────────────────────────────

  fastify.get('/admin/settings/routing', adminGuard, async (_req, reply) => {
    return reply.send(await getRoutingConfigForUI());
  });

  const routingSchema = z.object({ costWeight: z.number().min(0).max(1) });

  fastify.put('/admin/settings/routing', adminGuard, async (request, reply) => {
    const body = routingSchema.parse(request.body);
    await setCostWeight(body.costWeight);
    return reply.send(await getRoutingConfigForUI());
  });

  // ── Response cache ────────────────────────────────────────────────

  fastify.get('/admin/settings/cache', adminGuard, async (_req, reply) => {
    return reply.send(await getCacheConfigForUI());
  });

  const cacheSchema = z.object({
    enabled:    z.boolean(),
    ttlSeconds: z.number().int().min(1).max(2592000), // up to 30 days
  });

  fastify.put('/admin/settings/cache', adminGuard, async (request, reply) => {
    const body = cacheSchema.parse(request.body);
    await setCacheConfig(body.enabled, body.ttlSeconds);
    return reply.send(await getCacheConfigForUI());
  });

  // ── Providers ─────────────────────────────────────────────────────

  fastify.get('/admin/providers', adminGuard, async (_req, reply) => {
    const providers = await prisma.nexusProvider.findMany({
      include: { _count: { select: { keys: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send({ providers });
  });

  const providerSchema = z.object({
    name:           z.string().min(1),
    slug:           z.string().min(1).regex(/^[a-z0-9-]+$/),
    provider:       z.enum(['anthropic', 'openai', 'google', 'groq', 'openrouter', 'custom']),
    tier:           z.enum(['premium', 'standard', 'fast']).default('standard'),
    preferredModel: z.string().optional(),
    baseUrl:        z.string().url().optional(),
    modelFetchUrl:  z.string().url().optional(),
    authHeader:     z.string().default('Authorization'),
    authPrefix:     z.string().optional(),
    modelIdPath:    z.string().default('data[].id'),
  });

  // Reject provider base/fetch URLs that resolve to a blocked internal host, so a
  // malicious URL is stopped at the door rather than persisted (SSRF defense).
  async function assertProviderUrlsSafe(body: { baseUrl?: string; modelFetchUrl?: string }): Promise<string | null> {
    const policy = await getSsrfPolicy();
    for (const url of [body.baseUrl, body.modelFetchUrl]) {
      if (!url) continue;
      try { assertSafeUrl(url, policy); }
      catch (err) { return err instanceof Error ? err.message : 'Blocked URL'; }
    }
    return null;
  }

  fastify.post('/admin/providers', adminGuard, async (request, reply) => {
    const body = providerSchema.parse(request.body);
    const urlErr = await assertProviderUrlsSafe(body);
    if (urlErr) return reply.code(400).send({ error: urlErr });
    const existing = await prisma.nexusProvider.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: 'Slug already exists' });
    const provider = await prisma.nexusProvider.create({ data: { id: randomUUID(), ...body } });
    return reply.code(201).send({ provider });
  });

  fastify.patch('/admin/providers/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = providerSchema.partial().parse(request.body);
    const urlErr = await assertProviderUrlsSafe(body);
    if (urlErr) return reply.code(400).send({ error: urlErr });
    const provider = await prisma.nexusProvider.update({ where: { id }, data: body });
    return reply.send({ provider });
  });

  fastify.delete('/admin/providers/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusProvider.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // ── Keys ──────────────────────────────────────────────────────────

  fastify.get('/admin/providers/:providerId/keys', adminGuard, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const keys = await prisma.nexusKey.findMany({
      where:   { providerId },
      orderBy: { createdAt: 'asc' },
      include: { ownerTeam: { select: { name: true } } },
    });
    // ownerTeamName is flattened for the dashboard's Owner column; null = shared pool.
    return reply.send({
      keys: keys.map(({ encryptedKey: _drop, ownerTeam, ...k }) => ({
        ...k, ownerTeamName: ownerTeam?.name ?? null,
      })),
    });
  });

  const keySchema = z.object({
    apiKey:   z.string().min(1),
    label:    z.string().optional(),
    rpmLimit: z.number().int().min(1).default(60),
    tpmLimit: z.number().int().min(1).default(100000),
    // BYOK: null/omitted = shared pool. Set to make the key private to one team.
    ownerTeamId: z.string().uuid().nullish(),
  });

  fastify.post('/admin/providers/:providerId/keys', adminGuard, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const body = keySchema.parse(request.body);
    // Reject an unknown owner up front: the FK would throw a 500, and silently
    // dropping the owner would publish a private credential to the shared pool.
    if (body.ownerTeamId) {
      const owner = await prisma.team.findUnique({ where: { id: body.ownerTeamId }, select: { id: true } });
      if (!owner) return reply.code(400).send({ error: 'ownerTeamId does not match any team' });
    }
    const key = await prisma.nexusKey.create({
      data: {
        id:           randomUUID(),
        providerId,
        label:        body.label,
        encryptedKey: encrypt(body.apiKey),
        maskedKey:    maskKey(body.apiKey),
        rpmLimit:     body.rpmLimit,
        tpmLimit:     body.tpmLimit,
        ownerTeamId:  body.ownerTeamId ?? null,
      },
    });
    return reply.code(201).send({ key: { ...key, encryptedKey: undefined } });
  });

  fastify.delete('/admin/keys/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusKey.delete({ where: { id } });
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/ban', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await banKey(id);
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/unban', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Clear the Redis breaker state too, or the key would stay gated after unban.
    await breakerReset(id);
    await prisma.nexusKey.update({ where: { id }, data: { status: 'active', coolingUntil: null } });
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/test', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await testKey(id);
    return reply.send(result);
  });

  fastify.post('/admin/keys/:id/cool', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await coolKey(id, 60);
    return reply.send({ success: true });
  });

  // ── Model Registry ────────────────────────────────────────────────

  fastify.get('/admin/models', adminGuard, async (_req, reply) => {
    const models = await getModelRegistry();
    return reply.send({ models });
  });

  fastify.put('/admin/models', adminGuard, async (request, reply) => {
    const { models } = request.body as { models: Parameters<typeof updateModelRegistry>[0] };
    await updateModelRegistry(models);
    return reply.send({ success: true });
  });

  // ── Usage / Analytics ─────────────────────────────────────────────

  fastify.get('/admin/usage', adminGuard, async (request, reply) => {
    const { period = '30d', from, to } = request.query as { period?: 'today' | '7d' | '30d' | '90d'; from?: string; to?: string };
    const cSince = from ? new Date(from + 'T00:00:00.000Z') : undefined;
    const cUntil = to   ? new Date(to   + 'T23:59:59.999Z') : undefined;
    const summary = await getUsageSummary(period, cSince, cUntil);
    return reply.send(summary);
  });

  fastify.get('/admin/usage/by-team-key', adminGuard, async (request, reply) => {
    const { period = '30d', from, to } = request.query as { period?: 'today' | '7d' | '30d' | '90d'; from?: string; to?: string };
    const cSince = from ? new Date(from + 'T00:00:00.000Z') : undefined;
    const cUntil = to   ? new Date(to   + 'T23:59:59.999Z') : undefined;
    const leaderboard = await getUsageByTeamKey(period, cSince, cUntil);
    return reply.send({ leaderboard });
  });

  fastify.get('/admin/usage/by-day', adminGuard, async (request, reply) => {
    const { days = '30' } = request.query as { days?: string };
    const since = new Date(Date.now() - parseInt(days, 10) * 86400000);
    const rows  = await prisma.tokenUsage.findMany({
      where:   { createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });
    const dayMap = new Map<string, number>();
    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) ?? 0) + r.totalTokens);
    }
    return reply.send({
      byDay: Array.from(dayMap.entries()).map(([date, tokens]) => ({ date, tokens })),
    });
  });

  // ── Analytics time series ─────────────────────────────────────────

  fastify.get('/admin/analytics/timeseries/teams', adminGuard, async (request, reply) => {
    const { period = '30d', from, to } = request.query as { period?: 'today' | '7d' | '30d' | '90d'; from?: string; to?: string };
    const cSince = from ? new Date(from + 'T00:00:00.000Z') : undefined;
    const cUntil = to   ? new Date(to   + 'T23:59:59.999Z') : undefined;
    const series = await getTimeSeriesByTeam(period, cSince, cUntil);
    return reply.send({ series });
  });

  fastify.get('/admin/analytics/timeseries/models', adminGuard, async (request, reply) => {
    const { period = '30d', from, to } = request.query as { period?: 'today' | '7d' | '30d' | '90d'; from?: string; to?: string };
    const cSince = from ? new Date(from + 'T00:00:00.000Z') : undefined;
    const cUntil = to   ? new Date(to   + 'T23:59:59.999Z') : undefined;
    const series = await getTimeSeriesByModel(period, cSince, cUntil);
    return reply.send({ series });
  });

  // ── Settings ──────────────────────────────────────────────────────

  fastify.get('/admin/settings', adminGuard, async (_req, reply) => {
    const rows = await prisma.appSettings.findMany();
    // Never expose encrypted values
    const safe = rows
      .filter(r => r.key !== 'ENCRYPTION_SECRET')
      .map(r => ({ key: r.key, value: r.key === 'NEXUS_API_KEY' ? maskKey(r.value) : r.value }));
    return reply.send({ settings: safe });
  });

  fastify.post('/admin/settings', adminGuard, async (request, reply) => {
    const { key, value } = request.body as { key: string; value: string };
    if (key === 'ENCRYPTION_SECRET') return reply.code(403).send({ error: 'Forbidden' });
    await setSetting(key, value);
    return reply.send({ success: true });
  });

  // ── Teams ─────────────────────────────────────────────────────────
  // Phase 5 backend: the Team entity + budget hierarchy. The Teams dashboard tab
  // rebuild (Phase 8) consumes this API.

  const teamSchema = z.object({
    name:         z.string().min(1).max(80),
    status:       z.enum(['active', 'suspended']).default('active'),
    assignedTier: z.enum(['premium', 'standard', 'fast']).nullish(),
    budgetUsd:    z.number().positive().nullish(),
    budgetPeriod: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
    // BYOK: may this team's traffic fall back to the shared pool once its own
    // provider keys are exhausted? Ignored for teams that own no keys.
    byokFallback: z.boolean().default(true),
  });

  fastify.get('/admin/teams', adminGuard, async (_req, reply) => {
    const teams = await prisma.team.findMany({
      include: { _count: { select: { teamKeys: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // Current-period spend per team — a Redis read each (seeded from DB on miss);
    // fine at admin-page frequency.
    const withSpend = await Promise.all(teams.map(async (t) => ({
      id:           t.id,
      name:         t.name,
      status:       t.status,
      assignedTier: t.assignedTier,
      budgetUsd:    t.budgetUsd,
      budgetPeriod: t.budgetPeriod,
      keyCount:     t._count.teamKeys,
      spendUsd:     await getCurrentSpend(t.id, t.budgetPeriod as BudgetPeriod),
      createdAt:    t.createdAt,
    })));
    return reply.send({ teams: withSpend });
  });

  fastify.post('/admin/teams', adminGuard, async (request, reply) => {
    const body = teamSchema.parse(request.body);
    const team = await prisma.team.create({ data: { id: randomUUID(), ...body } });
    return reply.code(201).send({ team });
  });

  fastify.patch('/admin/teams/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = teamSchema.partial().parse(request.body);
    const team   = await prisma.team.update({ where: { id }, data: body });
    return reply.send({ team });
  });

  fastify.delete('/admin/teams/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Access keys survive their team (NexusTeamKey.teamId → NULL), losing only the
    // budget cap. The team's *owned provider keys* (BYOK) are deleted with it — a
    // private credential must never be released into the shared pool. The dashboard
    // warns before this runs; the count is returned so a caller can too.
    const ownedKeys = await prisma.nexusKey.count({ where: { ownerTeamId: id } });
    await prisma.team.delete({ where: { id } });
    return reply.send({ success: true, deletedOwnedKeys: ownedKeys });
  });

  // ── Team keys ─────────────────────────────────────────────────────

  fastify.get('/admin/team-keys', adminGuard, async (_req, reply) => {
    const keys = await prisma.nexusTeamKey.findMany({ orderBy: { createdAt: 'asc' }, include: { team: { select: { id: true, name: true } } } });
    return reply.send({ keys: keys.map(k => ({ id: k.id, name: k.name, maskedKey: k.maskedKey, team: k.team, createdAt: k.createdAt })) });
  });

  fastify.post('/admin/team-keys', adminGuard, async (request, reply) => {
    const { name, teamId } = request.body as { name: string; teamId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    if (teamId) {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) return reply.code(400).send({ error: 'teamId does not match an existing team' });
    }
    const plain      = 'nx_' + randomBytes(24).toString('hex');
    const keyHash    = createHash('sha256').update(plain).digest('hex');
    const maskedKey  = plain.slice(0, 6) + '••••••••' + plain.slice(-4);
    const created    = await prisma.nexusTeamKey.create({
      data: { id: randomUUID(), name: name.trim(), encryptedKey: encrypt(plain), keyHash, maskedKey, teamId: teamId ?? null },
    });
    return reply.code(201).send({
      key: { id: created.id, name: created.name, maskedKey, teamId: created.teamId, createdAt: created.createdAt, plainKey: plain },
    });
  });

  fastify.patch('/admin/team-keys/:id', adminGuard, async (request, reply) => {
    const { id }     = request.params as { id: string };
    const { teamId } = request.body as { teamId: string | null };
    if (teamId) {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) return reply.code(400).send({ error: 'teamId does not match an existing team' });
    }
    const key = await prisma.nexusTeamKey.update({ where: { id }, data: { teamId: teamId ?? null } });
    return reply.send({ key: { id: key.id, name: key.name, teamId: key.teamId } });
  });

  fastify.get('/admin/team-keys/:id/reveal', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tk = await prisma.nexusTeamKey.findUnique({ where: { id } });
    if (!tk) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ key: decrypt(tk.encryptedKey) });
  });

  fastify.delete('/admin/team-keys/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusTeamKey.delete({ where: { id } });
    await redis.del(`nexus:teamkey:${id}`);
    return reply.send({ success: true });
  });

  // ── Validation ────────────────────────────────────────────────────

  fastify.post('/admin/validate/provider', adminGuard, async (request, reply) => {
    const { provider, baseUrl, apiKey, authHeader = 'Authorization', authPrefix } =
      request.body as { provider: string; baseUrl?: string; apiKey: string; authHeader?: string; authPrefix?: string };
    if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' });
    const result = await validateProviderCredentials(provider, baseUrl ?? null, apiKey, authHeader, authPrefix ?? null);
    return reply.send(result);
  });

  fastify.post('/admin/validate/model', adminGuard, async (request, reply) => {
    const { providerId, modelName } = request.body as { providerId: string; modelName: string };
    if (!providerId || !modelName) return reply.code(400).send({ error: 'providerId and modelName are required' });
    const result = await validateModel(providerId, modelName);
    return reply.send(result);
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

  // ── Key RPM metrics ───────────────────────────────────────────────

  fastify.get('/admin/keys/:id/metrics', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const key    = await prisma.nexusKey.findUnique({ where: { id }, select: { rpmLimit: true, tpmLimit: true, status: true } });
    if (!key) return reply.code(404).send({ error: 'Not found' });
    const rpmRaw = await redis.get(`nexus:rpm:${id}`);
    const rpm    = parseInt(rpmRaw ?? '0', 10);
    return reply.send({ rpm, rpmLimit: key.rpmLimit, tpm: 0, tpmLimit: key.tpmLimit, status: key.status });
  });

  // ── Cache bust ────────────────────────────────────────────────────

  fastify.post('/admin/cache/flush', adminGuard, async (_req, reply) => {
    await redis.del(REGISTRY_CACHE_KEY);
    return reply.send({ success: true });
  });
}
