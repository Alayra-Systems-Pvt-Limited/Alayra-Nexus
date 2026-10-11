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

// ── Usage analytics ──────────────────────────────────────────────────────────────────────────
// The dashboard's read side of TokenUsage: summaries, per-team-key totals and day-bucketed series.
// Split out of token.service.ts (P0.5a) so the request path, which only records usage, never
// imports a database client. Nothing on the proxy path may import this file.

import { Prisma }          from '@prisma/client';
import { prisma }          from '../lib/prisma';
import { dual, dualQuery, dayKey, sqliteDay, type DualSql } from '../lib/dialect';

export type Period = 'today' | '7d' | '30d' | '90d';

function getSince(period: Period): Date {
  if (period === 'today') {
    const d = new Date();
    return new Date(d.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  }
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86400000);
}

function resolveRange(period: Period, customSince?: Date, customUntil?: Date): { since: Date; until: Date } {
  return {
    since: customSince ?? getSince(period),
    until: customUntil ?? new Date(),
  };
}

// Analytics aggregation is pushed down to Postgres rather than pulled into memory. A 30- or
// 90-day window in a busy deployment holds far too many rows to load and fold in JavaScript;
// `aggregate`/`groupBy` (bounded by model/provider/team cardinality) and a `date_trunc` GROUP
// BY for the day-bucketed series each return a fixed, tiny result regardless of row count.

export async function getUsageSummary(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const where = { createdAt: { gte: since, lte: until } };

  const [totalsAgg, byModelRows, byProviderRows, byDayRows] = await Promise.all([
    prisma.tokenUsage.aggregate({
      where, _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, estimatedUsd: true },
    }),
    prisma.tokenUsage.groupBy({
      by: ['modelName'], where, _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, estimatedUsd: true },
    }),
    prisma.tokenUsage.groupBy({
      by: ['provider'], where, _count: { _all: true },
      _sum: { totalTokens: true, estimatedUsd: true },
    }),
    // Day buckets can't be expressed with the typed groupBy (createdAt is a full timestamp),
    // so date_trunc is pushed down in raw SQL; sums are cast to float8 so the driver yields
    // plain numbers rather than BigInt/Decimal.
    dualQuery<{ day: Date | string; tokens: number; inputTokens: number; outputTokens: number; requests: number; usd: number }>(
      USAGE_BY_DAY(since, until)),
  ]);

  const totals = {
    requests:     totalsAgg._count._all      ?? 0,
    inputTokens:  totalsAgg._sum.inputTokens  ?? 0,
    outputTokens: totalsAgg._sum.outputTokens ?? 0,
    totalTokens:  totalsAgg._sum.totalTokens  ?? 0,
    estimatedUsd: totalsAgg._sum.estimatedUsd ?? 0,
  };

  const byModel: Record<string, { inputTokens: number; outputTokens: number; tokens: number; usd: number; requests: number }> = {};
  for (const r of byModelRows) {
    byModel[r.modelName] = {
      inputTokens:  r._sum.inputTokens  ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      tokens:       r._sum.totalTokens  ?? 0,
      usd:          r._sum.estimatedUsd ?? 0,
      requests:     r._count._all       ?? 0,
    };
  }

  const byProvider: Record<string, { tokens: number; usd: number; requests: number }> = {};
  for (const r of byProviderRows) {
    byProvider[r.provider] = {
      tokens:   r._sum.totalTokens  ?? 0,
      usd:      r._sum.estimatedUsd ?? 0,
      requests: r._count._all       ?? 0,
    };
  }

  const byDay = byDayRows.map((r) => ({
    date:         dayKey(r.day),
    tokens:       r.tokens       ?? 0,
    inputTokens:  r.inputTokens  ?? 0,
    outputTokens: r.outputTokens ?? 0,
    requests:     r.requests     ?? 0,
    usd:          r.usd          ?? 0,
  }));

  return { period, since: since.toISOString(), until: until.toISOString(), totals, byModel, byProvider, byDay };
}

export async function getUsageByTeamKey(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const grouped = await prisma.tokenUsage.groupBy({
    by:      ['nexusTeamKeyId'],
    where:   { createdAt: { gte: since, lte: until }, nexusTeamKeyId: { not: null } },
    _count:  { _all: true },
    _sum:    { inputTokens: true, outputTokens: true, totalTokens: true, estimatedUsd: true },
  });

  // Resolve names in one bounded lookup (groupBy can't include a relation). A key deleted
  // since it logged usage drops out here, matching the old inner-join behaviour.
  const ids  = grouped.map((g) => g.nexusTeamKeyId).filter((x): x is string => !!x);
  const keys = ids.length
    ? await prisma.nexusTeamKey.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(keys.map((k) => [k.id, k.name]));

  return grouped
    .filter((g) => g.nexusTeamKeyId && nameById.has(g.nexusTeamKeyId))
    .map((g) => ({
      id:           g.nexusTeamKeyId as string,
      name:         nameById.get(g.nexusTeamKeyId as string) ?? '',
      inputTokens:  g._sum.inputTokens  ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      totalTokens:  g._sum.totalTokens  ?? 0,
      requests:     g._count._all       ?? 0,
      estimatedUsd: g._sum.estimatedUsd ?? 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// ── Day-bucketed queries ─────────────────────────────────────────────────────────────────────
// Day buckets cannot be expressed through the typed groupBy (createdAt is a full timestamp), so the
// truncation is pushed down as raw SQL — which is where the two engines diverge. See lib/dialect.ts;
// the parity suite runs these exact texts against both.

export const USAGE_BY_DAY = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day,
             SUM("totalTokens")::float8    AS tokens,
             SUM("inputTokens")::float8    AS "inputTokens",
             SUM("outputTokens")::float8   AS "outputTokens",
             COUNT(*)::int                 AS requests,
             SUM("estimatedUsd")::float8   AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,

  Prisma.sql`
      SELECT ${Prisma.raw(sqliteDay('"createdAt"'))} AS day,
             CAST(SUM("totalTokens") AS REAL)        AS tokens,
             CAST(SUM("inputTokens") AS REAL)        AS "inputTokens",
             CAST(SUM("outputTokens") AS REAL)       AS "outputTokens",
             CAST(COUNT(*) AS REAL)                  AS requests,
             CAST(SUM("estimatedUsd") AS REAL)       AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,
);

// The JOIN both attaches the display name and enforces "team traffic only" — a null team-key id
// cannot match. Ordering carries a tiebreaker on the key id so two teams with traffic on the same
// day come back in a stable order on both engines rather than whichever the planner preferred.
export const USAGE_BY_TEAM = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
    SELECT date_trunc('day', u."createdAt") AS day,
           u."nexusTeamKeyId"               AS "teamKeyId",
           k."name"                         AS "teamName",
           COUNT(*)::int                    AS requests,
           SUM(u."totalTokens")::float8     AS tokens
    FROM "TokenUsage" u
    JOIN "NexusTeamKey" k ON k.id = u."nexusTeamKeyId"
    WHERE u."createdAt" >= ${since} AND u."createdAt" <= ${until}
    GROUP BY day, u."nexusTeamKeyId", k."name"
    ORDER BY day ASC, u."nexusTeamKeyId" ASC`,

  Prisma.sql`
    SELECT ${Prisma.raw(sqliteDay('u."createdAt"'))} AS day,
           u."nexusTeamKeyId"                        AS "teamKeyId",
           k."name"                                  AS "teamName",
           CAST(COUNT(*) AS REAL)                    AS requests,
           CAST(SUM(u."totalTokens") AS REAL)        AS tokens
    FROM "TokenUsage" u
    JOIN "NexusTeamKey" k ON k.id = u."nexusTeamKeyId"
    WHERE u."createdAt" >= ${since} AND u."createdAt" <= ${until}
    GROUP BY day, u."nexusTeamKeyId", k."name"
    ORDER BY day ASC, u."nexusTeamKeyId" ASC`,
);

export const USAGE_BY_MODEL = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
    SELECT date_trunc('day', "createdAt") AS day,
           "modelName"                    AS model,
           SUM("totalTokens")::float8     AS tokens
    FROM "TokenUsage"
    WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
    GROUP BY day, "modelName"
    ORDER BY day ASC, "modelName" ASC`,

  Prisma.sql`
    SELECT ${Prisma.raw(sqliteDay('"createdAt"'))} AS day,
           "modelName"                             AS model,
           CAST(SUM("totalTokens") AS REAL)        AS tokens
    FROM "TokenUsage"
    WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
    GROUP BY day, "modelName"
    ORDER BY day ASC, "modelName" ASC`,
);

export async function getTimeSeriesByTeam(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  // Day × team-key buckets, aggregated in Postgres. The JOIN both attaches the display name
  // and enforces "team traffic only" (a null team-key id cannot match). `teamId` preserves the
  // existing shape, which labels the team-*key* id as teamId.
  const rows = await dualQuery<{ day: Date | string; teamKeyId: string; teamName: string; requests: number; tokens: number }>(
    USAGE_BY_TEAM(since, until));

  return rows.map((r) => ({
    date:      dayKey(r.day),
    teamKeyId: r.teamKeyId,
    teamName:  r.teamName,
    // Legacy alias kept for backward compatibility; holds a team-key id, not a team id.
    teamId:    r.teamKeyId,
    requests:  r.requests ?? 0,
    tokens:    r.tokens   ?? 0,
  }));
}

export async function getTimeSeriesByModel(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const rows = await dualQuery<{ day: Date | string; model: string; tokens: number }>(
    USAGE_BY_MODEL(since, until));

  return rows.map((r) => ({
    date:   dayKey(r.day),
    model:  r.model,
    tokens: r.tokens ?? 0,
  }));
}
