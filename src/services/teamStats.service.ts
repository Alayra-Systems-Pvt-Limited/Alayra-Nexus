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

// Per-team analytics (Phase 7.10): the read behind the Teams → Team Stats tab. The global Analytics
// page answers "how is the gateway doing"; this answers the same questions for one team, plus the one
// thing only a team has — a per-key ("member") breakdown, so an operator can see which key inside a
// team is spending the budget. Every figure is a Postgres aggregate over TokenUsage joined to the
// team's keys, so the result stays small no matter how many rows the window holds.
//
// Two windows coexist on purpose: `period` (today/7d/30d/90d) is the *viewing* window the operator
// picks; `budget` reports the team's *current budget window* spend vs cap (daily/weekly/monthly),
// read the same way admission reads it, so the number here matches what the gateway actually enforces.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dual, dualQuery, dayKey, toDate, sqliteDay, type DualSql } from '../lib/dialect';
import { dateRange, fillSeries } from '../lib/series';
import { getCurrentSpend, type BudgetPeriod } from './budget.service';

export type TeamStatsPeriod = 'today' | '7d' | '30d' | '90d';

function sinceFor(period: TeamStatsPeriod): Date {
  if (period === 'today') return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface TeamStatsMember {
  id: string; name: string; maskedKey: string;
  requests: number; tokens: number; usd: number; lastUsedAt: string | null;
}

export interface TeamStats {
  team: {
    id: string; name: string; status: string;
    assignedTier: string | null; overBudgetAction: string;
    budgetUsd: number | null; budgetPeriod: string;
    /** Spend in the *current budget window* — the figure admission enforces against the cap. */
    budgetSpendUsd: number;
    keyCount: number;
  };
  period: TeamStatsPeriod;
  since:  string;
  until:  string;
  totals: {
    requests: number; successes: number; errors: number; successRate: number;
    totalTokens: number; estimatedUsd: number; avgLatencyMs: number;
  };
  byDay:    { date: string; requests: number; usd: number; tokens: number }[];
  byModel:  { model: string; requests: number; tokens: number; usd: number }[];
  members:  TeamStatsMember[];
}

type TotalsRow = {
  requests: number; successes: number;
  totalTokens: number | null; estimatedUsd: number | null; avgLatencyMs: number | null;
};
// `day` and `lastUsedAt` arrive in different shapes per engine — a timestamp vs a `YYYY-MM-DD`
// string, and a Date vs epoch millis. `dayKey()` and `toDate()` are the only things that read them.
type DayRow    = { day: Date | string; requests: number; usd: number | null; tokens: number | null };
type ModelRow  = { model: string; requests: number; tokens: number | null; usd: number | null };
type MemberRow = { id: string; name: string; maskedKey: string; requests: number; tokens: number | null; usd: number | null; lastUsedAt: Date | string | number | null };

// ── Queries ──────────────────────────────────────────────────────────────────────────────────
// Engine pairs; the parity suite runs these exact texts against both. The `ORDER BY` clauses gained
// tiebreakers on a unique column so tied rows come back in the same order from either engine —
// without one, the two disagree and neither was ever deterministic.

export const TEAM_TOTALS = (teamId: string, since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT COUNT(*)::int                                            AS requests,
             COUNT(*) FILTER (WHERE tu."outcome" = 'success')::int    AS successes,
             SUM(tu."totalTokens")::float8                            AS "totalTokens",
             SUM(tu."estimatedUsd")::float8                           AS "estimatedUsd",
             AVG(tu."latencyMs") FILTER (WHERE tu."latencyMs" > 0)::float8 AS "avgLatencyMs"
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}`,

  Prisma.sql`
      SELECT CAST(COUNT(*) AS REAL)                                              AS requests,
             CAST(COUNT(*) FILTER (WHERE tu."outcome" = 'success') AS REAL)      AS successes,
             CAST(SUM(tu."totalTokens") AS REAL)                                 AS "totalTokens",
             CAST(SUM(tu."estimatedUsd") AS REAL)                                AS "estimatedUsd",
             CAST(AVG(tu."latencyMs") FILTER (WHERE tu."latencyMs" > 0) AS REAL) AS "avgLatencyMs"
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}`,
);

export const TEAM_BY_DAY = (teamId: string, since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT date_trunc('day', tu."createdAt")   AS day,
             COUNT(*)::int                       AS requests,
             SUM(tu."estimatedUsd")::float8      AS usd,
             SUM(tu."totalTokens")::float8       AS tokens
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,

  Prisma.sql`
      SELECT ${Prisma.raw(sqliteDay('tu."createdAt"'))} AS day,
             CAST(COUNT(*) AS REAL)                     AS requests,
             CAST(SUM(tu."estimatedUsd") AS REAL)       AS usd,
             CAST(SUM(tu."totalTokens") AS REAL)        AS tokens
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,
);

export const TEAM_BY_MODEL = (teamId: string, since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT tu."modelName"               AS model,
             COUNT(*)::int                AS requests,
             SUM(tu."totalTokens")::float8 AS tokens,
             SUM(tu."estimatedUsd")::float8 AS usd
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
        AND tu."modelName" <> ''
      GROUP BY tu."modelName" ORDER BY requests DESC, tu."modelName" ASC LIMIT ${TOP_MODELS}`,

  Prisma.sql`
      SELECT tu."modelName"                      AS model,
             CAST(COUNT(*) AS REAL)              AS requests,
             CAST(SUM(tu."totalTokens") AS REAL) AS tokens,
             CAST(SUM(tu."estimatedUsd") AS REAL) AS usd
      FROM "TokenUsage" tu
      JOIN "NexusTeamKey" tk ON tk."id" = tu."nexusTeamKeyId"
      WHERE tk."teamId" = ${teamId} AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
        AND tu."modelName" <> ''
      GROUP BY tu."modelName" ORDER BY requests DESC, tu."modelName" ASC LIMIT ${TOP_MODELS}`,
);

// Member breakdown. A LEFT JOIN from the team's keys so an idle key still appears (with zeros)
// rather than vanishing — an operator wants to see every member, not only the busy ones.
//
// `lastUsedAt` is the MAX(datetime) trap: Postgres returns a Date, SQLite the raw epoch-millis
// INTEGER. No cast fixes that, so `toDate()` reconciles it where the row is consumed.
export const TEAM_MEMBERS = (teamId: string, since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT tk."id"                                    AS id,
             tk."name"                                  AS name,
             tk."maskedKey"                             AS "maskedKey",
             COUNT(tu."id")::int                        AS requests,
             COALESCE(SUM(tu."totalTokens"), 0)::float8 AS tokens,
             COALESCE(SUM(tu."estimatedUsd"), 0)::float8 AS usd,
             MAX(tu."createdAt")                        AS "lastUsedAt"
      FROM "NexusTeamKey" tk
      LEFT JOIN "TokenUsage" tu
        ON tu."nexusTeamKeyId" = tk."id" AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
      WHERE tk."teamId" = ${teamId}
      GROUP BY tk."id", tk."name", tk."maskedKey"
      ORDER BY usd DESC, requests DESC, tk."id" ASC`,

  Prisma.sql`
      SELECT tk."id"                                              AS id,
             tk."name"                                            AS name,
             tk."maskedKey"                                       AS "maskedKey",
             CAST(COUNT(tu."id") AS REAL)                         AS requests,
             CAST(COALESCE(SUM(tu."totalTokens"), 0) AS REAL)     AS tokens,
             CAST(COALESCE(SUM(tu."estimatedUsd"), 0) AS REAL)    AS usd,
             MAX(tu."createdAt")                                  AS "lastUsedAt"
      FROM "NexusTeamKey" tk
      LEFT JOIN "TokenUsage" tu
        ON tu."nexusTeamKeyId" = tk."id" AND tu."createdAt" >= ${since} AND tu."createdAt" <= ${until}
      WHERE tk."teamId" = ${teamId}
      GROUP BY tk."id", tk."name", tk."maskedKey"
      ORDER BY usd DESC, requests DESC, tk."id" ASC`,
);

const TOP_MODELS = 8;

/** Per-team stats for the viewing window, or null when the team does not exist. */
export async function getTeamStats(teamId: string, period: TeamStatsPeriod = '7d'): Promise<TeamStats | null> {
  const team = await prisma.team.findUnique({
    where:   { id: teamId },
    include: { _count: { select: { teamKeys: true } } },
  });
  if (!team) return null;

  const since = sinceFor(period);
  const until = new Date();

  const [totalsRows, dayRows, modelRows, memberRows, budgetSpendUsd] = await Promise.all([
    dualQuery<TotalsRow>(TEAM_TOTALS(teamId, since, until)),
    dualQuery<DayRow>(TEAM_BY_DAY(teamId, since, until)),
    dualQuery<ModelRow>(TEAM_BY_MODEL(teamId, since, until)),
    dualQuery<MemberRow>(TEAM_MEMBERS(teamId, since, until)),
    getCurrentSpend(teamId, team.budgetPeriod as BudgetPeriod),
  ]);

  const t         = totalsRows[0] ?? ({} as TotalsRow);
  const requests  = num(t.requests);
  const successes = num(t.successes);

  const byDay = fillSeries(
    dayRows.map((r) => ({
      date:     dayKey(r.day),
      requests: num(r.requests),
      usd:      num(r.usd),
      tokens:   num(r.tokens),
    })),
    dateRange(since, until),
    (date) => ({ date, requests: 0, usd: 0, tokens: 0 }),
  );

  return {
    team: {
      id:               team.id,
      name:             team.name,
      status:           team.status,
      assignedTier:     team.assignedTier,
      overBudgetAction: team.overBudgetAction,
      budgetUsd:        team.budgetUsd,
      budgetPeriod:     team.budgetPeriod,
      budgetSpendUsd:   num(budgetSpendUsd),
      keyCount:         team._count.teamKeys,
    },
    period,
    since: since.toISOString(),
    until: until.toISOString(),
    totals: {
      requests,
      successes,
      errors:       requests - successes,
      successRate:  requests > 0 ? successes / requests : 0,
      totalTokens:  num(t.totalTokens),
      estimatedUsd: num(t.estimatedUsd),
      avgLatencyMs: Math.round(num(t.avgLatencyMs)),
    },
    byDay,
    byModel: modelRows.map((r) => ({ model: r.model, requests: num(r.requests), tokens: num(r.tokens), usd: num(r.usd) })),
    members: memberRows.map((r) => ({
      id: r.id, name: r.name, maskedKey: r.maskedKey,
      requests: num(r.requests), tokens: num(r.tokens), usd: num(r.usd),
      lastUsedAt: toDate(r.lastUsedAt)?.toISOString() ?? null,
    })),
  };
}
