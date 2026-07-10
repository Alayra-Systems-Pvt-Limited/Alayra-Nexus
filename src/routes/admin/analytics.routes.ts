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

// Usage totals, per-team breakdowns, and daily time series.
import { FastifyInstance }      from 'fastify';
import { getUsageSummary, getUsageByTeamKey, getTimeSeriesByTeam, getTimeSeriesByModel } from '../../services/token.service';
import { prisma }              from '../../lib/prisma';
import { adminGuard }           from './guard';

export default async function adminAnalyticsRoutes(fastify: FastifyInstance) {
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
}
