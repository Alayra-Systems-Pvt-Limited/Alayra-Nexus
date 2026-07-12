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

// Provider pools and the credential/model validation probes.
import { FastifyInstance }      from 'fastify';
import { assertSafeUrl }         from '../../lib/url';
import { getSsrfPolicy } from '../../services/ssrf.service';
import { prisma }              from '../../lib/prisma';
import { randomUUID } from 'crypto';
import { validateProviderCredentials, validateModel, fetchProviderModels } from '../../services/nexus.service';
import { z }                   from 'zod';
import { adminGuard, adminOwnerGuard } from './guard';

export default async function adminProvidersRoutes(fastify: FastifyInstance) {
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
    // Extra request headers as an object; persisted as a JSON string. An empty object clears them.
    extraHeaders:   z.record(z.string()).optional(),
  });

  // Turn a validated provider body into a Prisma-ready row: the object-form extraHeaders is
  // serialized to the JSON string the column stores (empty object → null, i.e. "clear them").
  function toProviderData<T extends { extraHeaders?: Record<string, string> }>(body: T): Omit<T, 'extraHeaders'> & { extraHeaders?: string | null } {
    const { extraHeaders, ...rest } = body;
    if (extraHeaders === undefined) return rest;
    return { ...rest, extraHeaders: Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : null };
  }

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

  fastify.post('/admin/providers', adminOwnerGuard, async (request, reply) => {
    const body = providerSchema.parse(request.body);
    const urlErr = await assertProviderUrlsSafe(body);
    if (urlErr) return reply.code(400).send({ error: urlErr });
    const existing = await prisma.nexusProvider.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: 'Slug already exists' });
    const provider = await prisma.nexusProvider.create({ data: { id: randomUUID(), ...toProviderData(body) } });
    return reply.code(201).send({ provider });
  });

  fastify.patch('/admin/providers/:id', adminOwnerGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = providerSchema.partial().parse(request.body);
    const urlErr = await assertProviderUrlsSafe(body);
    if (urlErr) return reply.code(400).send({ error: urlErr });
    const provider = await prisma.nexusProvider.update({ where: { id }, data: toProviderData(body) });
    return reply.send({ provider });
  });

  fastify.delete('/admin/providers/:id', adminOwnerGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusProvider.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // ── Validation ────────────────────────────────────────────────────

  fastify.post('/admin/validate/provider', adminOwnerGuard, async (request, reply) => {
    const { provider, baseUrl, apiKey, authHeader = 'Authorization', authPrefix, extraHeaders } =
      request.body as { provider: string; baseUrl?: string; apiKey: string; authHeader?: string; authPrefix?: string; extraHeaders?: Record<string, string> };
    if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' });
    const extra = extraHeaders && Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : null;
    const result = await validateProviderCredentials(provider, baseUrl ?? null, apiKey, authHeader, authPrefix ?? null, extra);
    return reply.send(result);
  });

  fastify.post('/admin/validate/model', adminOwnerGuard, async (request, reply) => {
    const { providerId, modelName } = request.body as { providerId: string; modelName: string };
    if (!providerId || !modelName) return reply.code(400).send({ error: 'providerId and modelName are required' });
    const result = await validateModel(providerId, modelName);
    return reply.send(result);
  });

  // ── Live model discovery ──────────────────────────────────────────
  // Fetch the provider's current model list (used by the add-key "Fetch Models" flow). A
  // plaintext key may be supplied to probe before the key is saved; otherwise an existing
  // active key for the pool is used.
  fastify.post('/admin/providers/:id/fetch-models', adminOwnerGuard, async (request, reply) => {
    const { id }       = request.params as { id: string };
    const { plainKey } = (request.body ?? {}) as { plainKey?: string };
    const result = await fetchProviderModels(id, plainKey);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? 'Fetch failed', models: [] });
    return reply.send({ models: result.models });
  });
}
