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
import { adminGuard }           from './guard';

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

  // ── Key RPM metrics ───────────────────────────────────────────────

  fastify.get('/admin/keys/:id/metrics', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const key    = await prisma.nexusKey.findUnique({ where: { id }, select: { rpmLimit: true, tpmLimit: true, status: true } });
    if (!key) return reply.code(404).send({ error: 'Not found' });
    const rpmRaw = await redis.get(`nexus:rpm:${id}`);
    const rpm    = parseInt(rpmRaw ?? '0', 10);
    return reply.send({ rpm, rpmLimit: key.rpmLimit, tpm: 0, tpmLimit: key.tpmLimit, status: key.status });
  });
}
