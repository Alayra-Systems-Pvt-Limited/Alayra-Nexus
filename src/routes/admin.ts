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

  fastify.post('/admin/providers', adminGuard, async (request, reply) => {
    const body = providerSchema.parse(request.body);
    const existing = await prisma.nexusProvider.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: 'Slug already exists' });
    const provider = await prisma.nexusProvider.create({ data: { id: randomUUID(), ...body } });
    return reply.code(201).send({ provider });
  });

  fastify.patch('/admin/providers/:id', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = providerSchema.partial().parse(request.body);
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
    });
    return reply.send({ keys: keys.map(k => ({ ...k, encryptedKey: undefined })) });
  });

  const keySchema = z.object({
    apiKey:   z.string().min(1),
    label:    z.string().optional(),
    rpmLimit: z.number().int().min(1).default(60),
    tpmLimit: z.number().int().min(1).default(100000),
  });

  fastify.post('/admin/providers/:providerId/keys', adminGuard, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const body = keySchema.parse(request.body);
    const key = await prisma.nexusKey.create({
      data: {
        id:           randomUUID(),
        providerId,
        label:        body.label,
        encryptedKey: encrypt(body.apiKey),
        maskedKey:    maskKey(body.apiKey),
        rpmLimit:     body.rpmLimit,
        tpmLimit:     body.tpmLimit,
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

  // ── Team keys ─────────────────────────────────────────────────────

  fastify.get('/admin/team-keys', adminGuard, async (_req, reply) => {
    const keys = await prisma.nexusTeamKey.findMany({ orderBy: { createdAt: 'asc' } });
    return reply.send({ keys: keys.map(k => ({ id: k.id, name: k.name, maskedKey: k.maskedKey, createdAt: k.createdAt })) });
  });

  fastify.post('/admin/team-keys', adminGuard, async (request, reply) => {
    const { name } = request.body as { name: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    const plain      = 'nx_' + randomBytes(24).toString('hex');
    const keyHash    = createHash('sha256').update(plain).digest('hex');
    const maskedKey  = plain.slice(0, 6) + '••••••••' + plain.slice(-4);
    const created    = await prisma.nexusTeamKey.create({
      data: { id: randomUUID(), name: name.trim(), encryptedKey: encrypt(plain), keyHash, maskedKey },
    });
    return reply.code(201).send({
      key: { id: created.id, name: created.name, maskedKey, createdAt: created.createdAt, plainKey: plain },
    });
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
