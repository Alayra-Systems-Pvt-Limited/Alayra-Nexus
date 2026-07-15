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

// Teams, their budgets, and the scoped access keys they issue.
import { FastifyInstance }      from 'fastify';
import { encrypt, decrypt } from '../../lib/encryption';
import { getCurrentSpend, type BudgetPeriod } from '../../services/budget.service';
import { prisma }              from '../../lib/prisma';
import { randomUUID, createHash, randomBytes } from 'crypto';
import { redis }               from '../../lib/redis';
import { z }                   from 'zod';
import { adminGuard, adminOwnerGuard } from './guard';
import { ADMIN_WRITE_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';

export default async function adminTeamsRoutes(fastify: FastifyInstance) {
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

  fastify.post('/admin/teams', adminOwnerGuard, async (request, reply) => {
    const body = teamSchema.parse(request.body);
    const team = await prisma.team.create({ data: { id: randomUUID(), ...body } });
    return reply.code(201).send({ team });
  });

  fastify.patch('/admin/teams/:id', adminOwnerGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body   = teamSchema.partial().parse(request.body);
    const team   = await prisma.team.update({ where: { id }, data: body });
    return reply.send({ team });
  });

  fastify.delete('/admin/teams/:id', adminOwnerGuard, async (request, reply) => {
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

  fastify.post('/admin/team-keys', adminOwnerGuard, async (request, reply) => {
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

  fastify.patch('/admin/team-keys/:id', adminOwnerGuard, async (request, reply) => {
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

  fastify.delete('/admin/team-keys/:id', withRateLimit(adminOwnerGuard, ADMIN_WRITE_RATE_LIMIT), async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.nexusTeamKey.delete({ where: { id } });
    await redis.del(`nexus:teamkey:${id}`);
    return reply.send({ success: true });
  });
}
