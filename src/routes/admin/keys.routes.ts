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
import { testKey, banKey, coolKey, validateProviderCredentials } from '../../services/nexus.service';
import { keyProviderMismatch, providerLabel } from '../../lib/keyPrefix';
import { forgetLastUsed }     from '../../lib/lastUsed';
import { forgetKeyRow }       from '../../lib/keyRowCache';
import { z }                   from 'zod';
import { adminGuard, adminWriteGuard } from './guard';
import { ADMIN_READ_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';

/** What the two credential checks need to know about the pool a key is going into. */
type PoolForCheck = {
  provider: string; baseUrl: string | null;
  authHeader: string; authPrefix: string | null; extraHeaders: string | null;
};

/**
 * Is this credential plausibly, and then actually, a key for this pool's provider?
 *
 * Returns an operator-facing message to refuse the save with, or null to go ahead. Two checks, and
 * they answer different questions:
 *
 *   the PREFIX  — instant and offline. `sk-ant-` in an OpenRouter pool is a paste error, and saying
 *                 so before anything is written costs nothing. It can only ever catch a positive
 *                 mismatch; see lib/keyPrefix.ts for why an unrecognised key must pass.
 *   the PROVIDER — authoritative, and the only thing that can catch a revoked key, a typo, or the
 *                 `sk-` ambiguity no prefix can resolve. It costs a request and a few seconds.
 *
 * Only a 401 or 403 refuses the save. A 404 usually means the provider serves no `/models`, and a
 * timeout means the network is unhappy — neither is evidence about the key, and refusing on either
 * would make a working credential unsavable because something else was down.
 *
 * Why refuse at all, rather than warn: a wrong key SAVES fine and then fails on the request path,
 * where two auth failures ban it. The operator sees a pool that stopped working several minutes
 * after the action that broke it, with nothing connecting the two.
 */
async function credentialProblem(
  pool: PoolForCheck, apiKey: string, verify: boolean,
): Promise<string | null> {
  const mismatch = keyProviderMismatch(pool.provider, apiKey);
  if (mismatch) return mismatch;

  if (!verify) return null;

  const result = await validateProviderCredentials(
    pool.provider, pool.baseUrl, apiKey, pool.authHeader, pool.authPrefix, pool.extraHeaders,
  );
  if (result.status === 401 || result.status === 403) {
    return `${providerLabel(pool.provider)} rejected this key (HTTP ${result.status}). `
      + 'Check it was copied whole and has not been revoked.';
  }
  return null;
}

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
    // Call the provider to confirm the credential before saving. On by default because the failure
    // it prevents is silent and delayed; opt out for an air-gapped pool, or a provider that is down
    // when you need to add a key to it anyway.
    verify: z.boolean().default(true),
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

    // A pool serves one provider, and every key in it inherits that provider's base URL and auth
    // header. So a key from somewhere else is not a choice, it is a mistake — and one that fails
    // minutes later on the request path rather than here.
    const pool = await prisma.nexusProvider.findUnique({
      where:  { id: providerId },
      select: { provider: true, baseUrl: true, authHeader: true, authPrefix: true, extraHeaders: true },
    });
    if (!pool) return reply.code(404).send({ error: 'No such pool' });

    const problem = await credentialProblem(pool, body.apiKey, body.verify);
    if (problem) return reply.code(400).send({ error: problem });

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
    // A create has no cached ROW to drop — the key did not exist a moment ago — but it must still
    // reach the cached candidate LISTS, or the new key sits idle for up to a second while its pool
    // goes on reporting the headroom it had before. Adding a key to relieve a pool that is out of
    // headroom is the exact moment this matters.
    forgetKeyRow(key.id);
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
    verify:      z.boolean().default(true),
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
      // A rotation is a new credential, so it gets the same two checks a create does. Rotating a
      // live key to a wrong one is the worse of the two cases: the pool was working a moment ago,
      // which makes the eventual failure even harder to connect back to this action.
      const existing = await prisma.nexusKey.findUnique({
        where:  { id },
        select: { provider: { select: {
          provider: true, baseUrl: true, authHeader: true, authPrefix: true, extraHeaders: true,
        } } },
      });
      if (!existing) return reply.code(404).send({ error: 'No such key' });

      const problem = await credentialProblem(existing.provider, body.apiKey, body.verify);
      if (problem) return reply.code(400).send({ error: problem });

      data.encryptedKey = encrypt(body.apiKey);
      data.maskedKey    = maskKey(body.apiKey);
    }
    const key = await prisma.nexusKey.update({ where: { id }, data });
    // Limits, ownership and the credential itself all live on this row and are all read by
    // routing, so an edit has to drop the cached copy rather than wait out its second.
    forgetKeyRow(id);
    return reply.send({ key: { ...key, encryptedKey: undefined } });
  });

  fastify.delete('/admin/keys/:id', adminWriteGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusKey.delete({ where: { id } });
    forgetKeyRow(id);
    forgetLastUsed(id);
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
    forgetKeyRow(id);
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
