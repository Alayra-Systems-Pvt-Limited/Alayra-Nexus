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

// Provider API keys: create, ban, cool, test, live RPM.
import { FastifyInstance }      from 'fastify';
import { encrypt, maskKey } from '../../lib/encryption';
import { onSuccess as breakerReset } from '../../lib/breaker';
import { prisma }              from '../../lib/prisma';
import { randomUUID } from 'crypto';
import { redis }               from '../../lib/redis';
import { testKey, banKey, coolKey } from '../../services/nexus.service';
import { z }                   from 'zod';
import { adminGuard, adminWriteGuard } from './guard';
import { ADMIN_READ_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';

export default async function adminKeysRoutes(fastify: FastifyInstance) {
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
    maxUsers: z.number().int().min(1).default(1000),
    // BYOK: null/omitted = shared pool. Set to make the key private to one team.
    ownerTeamId: z.string().uuid().nullish(),
  });

  fastify.post('/admin/providers/:providerId/keys', adminWriteGuard, async (request, reply) => {
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
        maxUsers:     body.maxUsers,
        ownerTeamId:  body.ownerTeamId ?? null,
      },
    });
    return reply.code(201).send({ key: { ...key, encryptedKey: undefined } });
  });

  // Edit an existing key's label, limits, and (optionally) the credential itself. Deliberately
  // additive to create: status, coolingUntil, and lastUsedAt are never touched here, so an edit
  // can't accidentally unban a key or reset its health — those stay with ban/unban/cool. Supplying
  // `apiKey` rotates the credential (re-encrypt + re-mask); omitting it leaves the stored key intact.
  const keyEditSchema = z.object({
    apiKey:      z.string().min(1).optional(),
    label:       z.string().nullish(),
    rpmLimit:    z.number().int().min(1).optional(),
    tpmLimit:    z.number().int().min(1).optional(),
    maxUsers:    z.number().int().min(1).optional(),
    ownerTeamId: z.string().uuid().nullish(),
  });

  fastify.patch('/admin/keys/:id', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = keyEditSchema.parse(request.body);
    // Reject an unknown owner up front (same reasoning as create): the FK would 500, and a silent
    // drop would leak a private credential into the shared pool.
    if (body.ownerTeamId) {
      const owner = await prisma.team.findUnique({ where: { id: body.ownerTeamId }, select: { id: true } });
      if (!owner) return reply.code(400).send({ error: 'ownerTeamId does not match any team' });
    }
    // Build the update from only the fields that were sent, so an edit never clobbers an
    // untouched column with a default.
    const data: Record<string, unknown> = {};
    if (body.label !== undefined)       data.label       = body.label;
    if (body.rpmLimit !== undefined)    data.rpmLimit    = body.rpmLimit;
    if (body.tpmLimit !== undefined)    data.tpmLimit    = body.tpmLimit;
    if (body.maxUsers !== undefined)    data.maxUsers    = body.maxUsers;
    if (body.ownerTeamId !== undefined) data.ownerTeamId = body.ownerTeamId ?? null;
    if (body.apiKey) {
      data.encryptedKey = encrypt(body.apiKey);
      data.maskedKey    = maskKey(body.apiKey);
    }
    const key = await prisma.nexusKey.update({ where: { id }, data });
    return reply.send({ key: { ...key, encryptedKey: undefined } });
  });

  fastify.delete('/admin/keys/:id', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusKey.delete({ where: { id } });
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/ban', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await banKey(id);
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/unban', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Clear the Redis breaker state too, or the key would stay gated after unban.
    await breakerReset(id);
    await prisma.nexusKey.update({ where: { id }, data: { status: 'active', coolingUntil: null } });
    return reply.send({ success: true });
  });

  fastify.post('/admin/keys/:id/test', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await testKey(id);
    // `ok` is the wire contract the dashboard reads. The service's field is `success`; sending it
    // through unmapped once made EVERY test — pass or fail — render as "Failed" (r.ok was
    // undefined), while the audit trail showed the 200 that told the truth.
    return reply.send({ ok: result.success, latencyMs: result.latencyMs, error: result.error });
  });

  fastify.post('/admin/keys/:id/cool', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await coolKey(id, 60);
    return reply.send({ success: true });
  });

  // ── Key RPM metrics ───────────────────────────────────────────────

  fastify.get('/admin/keys/:id/metrics', withRateLimit(adminGuard, ADMIN_READ_RATE_LIMIT), async (request, reply) => {
    const { id } = request.params as { id: string };
    const key    = await prisma.nexusKey.findUnique({ where: { id }, select: { rpmLimit: true, tpmLimit: true, status: true } });
    if (!key) return reply.code(404).send({ error: 'Not found' });
    const rpmRaw = await redis.get(`nexus:rpm:${id}`);
    const rpm    = parseInt(rpmRaw ?? '0', 10);
    return reply.send({ rpm, rpmLimit: key.rpmLimit, tpm: 0, tpmLimit: key.tpmLimit, status: key.status });
  });
}
