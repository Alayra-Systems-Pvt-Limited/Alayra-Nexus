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

// Operator settings: SSRF policy, guardrails, cost routing, response cache.
import { FastifyInstance }      from 'fastify';
import { maskKey } from '../../lib/encryption';
import { getCacheConfigForUI, setCacheConfig } from '../../services/cache.service';
import { getGuardrailConfigForUI, setGuardrailConfig } from '../../services/guardrails.service';
import { getRoutingConfigForUI, setCostWeight } from '../../services/routing.service';
import { setSetting } from '../../services/settings.service';
import { getSsrfConfig, setSsrfConfig } from '../../services/ssrf.service';
import { prisma }              from '../../lib/prisma';
import { z }                   from 'zod';
import { adminGuard }           from './guard';

export default async function adminSettingsRoutes(fastify: FastifyInstance) {
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
}
