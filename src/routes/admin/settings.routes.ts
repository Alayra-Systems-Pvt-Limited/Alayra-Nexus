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
import { getNotificationConfigForUI, setNotificationConfig } from '../../services/notifications.service';
import { prisma }              from '../../lib/prisma';
import { z }                   from 'zod';
import { invalidBody }        from '../../lib/invalidBody';
import { adminGuard, adminOwnerGuard, adminWriteGuard } from './guard';

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

  // OWNER-ONLY, deliberately (7.13a), while the rest of Settings moved to owner-or-admin. This is
  // the boundary on where the gateway may connect, and an admin already chooses provider base URLs
  // — so an admin who could also edit the policy that constrains those URLs would be editing their
  // own leash. A control is only a control if the party it constrains cannot change it.
  fastify.put('/admin/settings/ssrf', adminOwnerGuard, async (request, reply) => {
    const parsed = ssrfSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'That is not a valid network policy.'));
    }
    const body = parsed.data;
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

  fastify.put('/admin/settings/guardrails', adminWriteGuard, async (request, reply) => {
    const parsed = guardrailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'That is not a valid guardrail configuration.'));
    }
    const body = parsed.data;
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

  fastify.put('/admin/settings/routing', adminWriteGuard, async (request, reply) => {
    const parsed = routingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'That is not a valid routing setting.'));
    }
    await setCostWeight(parsed.data.costWeight);
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

  fastify.put('/admin/settings/cache', adminWriteGuard, async (request, reply) => {
    const parsed = cacheSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'That is not a valid cache setting.'));
    }
    await setCacheConfig(parsed.data.enabled, parsed.data.ttlSeconds);
    return reply.send(await getCacheConfigForUI());
  });

  // ── Notifications (Phase 6.4) ─────────────────────────────────────

  fastify.get('/admin/settings/notifications', adminGuard, async (_req, reply) => {
    return reply.send(await getNotificationConfigForUI());
  });

  const notificationsSchema = z.object({
    enabled:      z.boolean(),
    // Omit or send the masked value to keep the stored key; '' clears it.
    resendApiKey: z.string().max(500).optional(),
    from:         z.string().max(200).default(''),
    to:           z.array(z.string().email()).max(20).default([]),
    webhookUrl:   z.string().url().max(500).or(z.literal('')).default(''),
    events:       z.object({
      keyBanned:       z.boolean().optional(),
      breakerOpened:   z.boolean().optional(),
      adminLockout:    z.boolean().optional(),
      budgetThreshold: z.boolean().optional(),
      tierExhausted:   z.boolean().optional(),
    }).default({}),
    windowSeconds: z.number().int().min(60).max(86400).default(3600),
  });

  fastify.put('/admin/settings/notifications', adminWriteGuard, async (request, reply) => {
    const parsed = notificationsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'That is not a valid notification setting.'));
    }
    await setNotificationConfig(parsed.data);
    return reply.send(await getNotificationConfigForUI());
  });

  // ── Settings ──────────────────────────────────────────────────────

  // Settings whose values this generic list must never carry. The API key's HASH joins the list in
  // 7.13a: it cannot be reversed, but it is the value the gateway checks credentials against, and a
  // raw settings dump is no place for it. The mask (NEXUS_API_KEY_MASK) is fine — it is a hint.
  const NEVER_LIST = new Set(['ENCRYPTION_SECRET', 'NEXUS_API_KEY_HASH']);

  fastify.get('/admin/settings', adminGuard, async (_req, reply) => {
    const rows = await prisma.appSettings.findMany();
    const safe = rows
      .filter(r => !NEVER_LIST.has(r.key))
      // NEXUS_API_KEY is converted to a hash at boot and its row deleted, so this should never
      // match. Kept as a belt-and-braces guard: if a plaintext key ever reappears, it must not be
      // this route that hands it out.
      .map(r => ({ key: r.key, value: r.key === 'NEXUS_API_KEY' ? maskKey(r.value) : r.value }));
    return reply.send({ settings: safe });
  });

  // OWNER-ONLY, deliberately (7.13a). This writes an ARBITRARY settings key, so it is every
  // owner-only setting at once wearing a generic coat: an admin holding it could set NEXUS_API_KEY
  // to a value they already know and hand themselves the gateway's front door. The specific,
  // schema-checked routes above are what an admin gets.
  fastify.post('/admin/settings', adminOwnerGuard, async (request, reply) => {
    const { key, value } = request.body as { key: string; value: string };
    if (key === 'ENCRYPTION_SECRET') return reply.code(403).send({ error: 'Forbidden' });
    // The API key is managed by its own service now (7.13a). Writing NEXUS_API_KEY here would be
    // WORSE than refused — it would appear to succeed and change nothing, because the gateway
    // authenticates against the hash. A refusal that names the right door beats a silent no-op.
    if (key === 'NEXUS_API_KEY' || key === 'NEXUS_API_KEY_HASH' || key === 'NEXUS_API_KEY_MASK') {
      return reply.code(400).send({
        error: 'The Nexus API key is not editable here. Use Rotate on the Connect page to issue a new one — it is shown once and stored only as a hash.',
      });
    }
    await setSetting(key, value);
    return reply.send({ success: true });
  });
}
