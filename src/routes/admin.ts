import { FastifyInstance }      from 'fastify';
import { z }                   from 'zod';
import { randomUUID }          from 'crypto';
import { verifyAdminPassword } from '../middleware/auth.middleware';
import { prisma }              from '../lib/prisma';
import { encrypt, maskKey }    from '../lib/encryption';
import { getSetting, setSetting } from '../services/settings.service';
import { getModelRegistry, updateModelRegistry } from '../services/model.service';
import { getUsageSummary }     from '../services/token.service';
import { testKey, banKey, coolKey } from '../services/nexus.service';
import { redis }               from '../lib/redis';
import { REGISTRY_CACHE_KEY }  from '../lib/registryCacheKey';

const adminGuard = { preHandler: [verifyAdminPassword] };

export default async function adminRoutes(fastify: FastifyInstance) {

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
    name:         z.string().min(1),
    slug:         z.string().min(1).regex(/^[a-z0-9-]+$/),
    provider:     z.enum(['anthropic', 'openai', 'google', 'groq', 'openrouter', 'custom']),
    baseUrl:      z.string().url().optional(),
    modelFetchUrl:z.string().url().optional(),
    authHeader:   z.string().default('Authorization'),
    authPrefix:   z.string().optional(),
    modelIdPath:  z.string().default('data[].id'),
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
    const { period = '30d' } = request.query as { period?: 'today' | '7d' | '30d' };
    const summary = await getUsageSummary(period);
    return reply.send(summary);
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

  // ── Cache bust ────────────────────────────────────────────────────

  fastify.post('/admin/cache/flush', adminGuard, async (_req, reply) => {
    await redis.del(REGISTRY_CACHE_KEY);
    return reply.send({ success: true });
  });
}
