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

import { prisma }          from '../lib/prisma';
import { randomUUID }      from 'crypto';
import { getModelRegistry } from './model.service';
import { emit }            from './usagePipeline';
import { addSpend, periodKey, type BudgetPeriod } from './budget.service';
import { notify } from './notifications.service';
import { budgetThresholdCrossed, budgetThresholdMessage } from '../lib/notify';
import { isUsageAnonymized } from './audit.service';
import { hashIdentifier }    from '../lib/audit';

type Period = 'today' | '7d' | '30d' | '90d';

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

// Handles both inputPricePer1k (old) and inputCostPer1M (new dashboard format)
function modelCost(m: Record<string, unknown>, input: number, output: number): number {
  const iPer1k = (m.inputPricePer1k  as number | undefined) ?? ((m.inputCostPer1M  as number | undefined) ?? 0) / 1000;
  const oPer1k = (m.outputPricePer1k as number | undefined) ?? ((m.outputCostPer1M as number | undefined) ?? 0) / 1000;
  return (input / 1000) * iPer1k + (output / 1000) * oPer1k;
}

// Per-modality cost (Phase 6.3b/6.3c). A non-token unit is priced from the model's
// per-unit price: images per image, synthesized speech per 1,000,000 characters (the
// unit TTS providers publish). Transcription joins in 6.3d. An unknown or unpriced unit
// costs 0 and never throws — accounting must never break a proxied request.
function unitCost(m: Record<string, unknown>, unit: string, quantity: number): number {
  const q = Math.max(0, quantity);
  if (unit === 'image')         return q * ((m.imagePrice as number | undefined) ?? 0);
  if (unit === 'character')     return (q / 1_000_000) * ((m.speechPricePer1MChars as number | undefined) ?? 0);
  if (unit === 'transcription') return q * ((m.transcriptionPrice as number | undefined) ?? 0);
  return 0;
}

export interface RecordTokenUsageParams {
  sessionId:       string;
  modelId:         string;
  modelName:       string;
  provider:        string;
  inputTokens:     number;
  outputTokens:    number;
  // Per-modality billing (Phase 6.3b). Omitted for token endpoints (defaults to
  // unit "token", quantity 0). An image request sets unit "image" and a quantity;
  // cost is then quantity × the model's per-unit price, not a token calculation.
  unit?:           string;
  quantity?:       number;
  nexusTeamKeyId?: string;
  // Team budget attribution: when set, this request's cost is added to the team's
  // current budget window as soon as it is known.
  teamId?:           string;
  teamBudgetPeriod?: string;
  // The team's spend cap for the window (Phase 6.4b). Threaded through so a threshold
  // crossing (80% / 100%) can be detected the moment this request's cost lands, without
  // a second budget read. null/undefined = no cap, so no threshold alert.
  teamBudgetUsd?:    number | null;
  // A response-cache hit: no provider was called, so it costs $0 and does not
  // consume budget. Still recorded (attributed to the team) so analytics are honest.
  cached?:           boolean;
  // End-to-end request latency (Phase 7.5). Recorded so latency can be charted from real data.
  latencyMs?:        number;
  // Usually "success". A stream that dies mid-flight is the exception: it delivered partial output
  // that the provider will bill for, so its tokens must still be recorded — but the request itself
  // failed, and calling it a success would quietly inflate the success rate.
  outcome?:          string;
}

export async function recordTokenUsage(p: RecordTokenUsageParams): Promise<void> {
  const unit     = p.unit ?? 'token';
  const quantity = p.quantity ?? 0;

  // The model's price for this request, computed the same way whether or not the cache served it.
  // On a normal request that price IS the cost; on a cache hit the provider was never called, so
  // the cost is zero and the same figure becomes the saving. Computing it once, for both, is what
  // makes "what has caching saved me" answerable — previously a cache hit stored a bare 0 and the
  // counterfactual was lost forever.
  let price = 0;
  try {
    const registry = await getModelRegistry();
    const matchesModel = (r: { modelString?: string; id?: string }): boolean =>
      r.modelString === p.modelName || r.id === p.modelId;
    const m = registry.find(matchesModel) as Record<string, unknown> | undefined;
    // Explicit fallback: a model not in the registry is treated as zero estimated spend.
    if (m) {
      price = unit === 'token'
        ? modelCost(m, p.inputTokens, p.outputTokens)
        : unitCost(m, unit, quantity);
    }
  } catch { /* non-fatal — never block a proxy request */ }

  const cached       = p.cached ?? false;
  const estimatedUsd = cached ? 0     : price;
  const savedUsd     = cached ? price : 0;

  // Record the request's real cost against the team's budget window (fire-and-
  // forget — budget accounting must never block or fail a proxied request). The new
  // running total addSpend returns lets us alert on an 80%/100% crossing (Phase 6.4b)
  // without a second read; still entirely off the request path.
  if (p.teamId && estimatedUsd > 0) {
    const period = (p.teamBudgetPeriod === 'daily' || p.teamBudgetPeriod === 'weekly' || p.teamBudgetPeriod === 'monthly')
      ? p.teamBudgetPeriod as BudgetPeriod : 'monthly';
    const teamId    = p.teamId;
    const budgetUsd = p.teamBudgetUsd ?? null;
    void addSpend(teamId, period, estimatedUsd)
      .then((newTotal) => {
        if (newTotal == null || budgetUsd == null) return;
        return alertBudgetThreshold(teamId, period, newTotal - estimatedUsd, newTotal, budgetUsd);
      })
      .catch(() => {});
  }

  // Compliance (Phase 6.7): when anonymization is on, the session fingerprint is the one
  // user-identifying field in a usage row, so it is replaced with a stable one-way hash —
  // per-session grouping still works, but the original value is never stored. The flag is
  // memoized in-process, so this stays a cheap check on the hot path.
  const sessionId = (await isUsageAnonymized()) ? hashIdentifier(p.sessionId) : p.sessionId;

  // Hand off to the async pipeline instead of writing to Postgres inline: the
  // request path never waits on the analytics INSERT, and writes are batched.
  emit({
    id:             randomUUID(),
    sessionId,
    modelId:        p.modelId,
    modelName:      p.modelName,
    provider:       p.provider,
    inputTokens:    p.inputTokens,
    outputTokens:   p.outputTokens,
    totalTokens:    p.inputTokens + p.outputTokens,
    unit,
    quantity,
    estimatedUsd,
    outcome:        p.outcome ?? 'success',
    latencyMs:      Math.max(0, Math.round(p.latencyMs ?? 0)),
    cached,
    savedUsd,
    nexusTeamKeyId: p.nexusTeamKeyId ?? null,
    createdAt:      new Date(),
  });
}

export interface RecordOutcomeParams {
  /** The outcome taxonomy shared with the Prometheus metrics — anything but "success". */
  outcome:         string;
  latencyMs:       number;
  /** Known only once routing has picked a pool; a request that failed before that has neither. */
  modelName?:      string | null;
  provider?:       string | null;
  nexusTeamKeyId?: string;
}

/**
 * Record a request that did not succeed (Phase 7.5). A failed request has no tokens, no cost, and
 * no saving, so it needs neither the registry lookup nor the budget path — it exists purely so the
 * dashboard can tell the truth about success rate, error mix, and latency. Before this, failures
 * were counted in Prometheus and then thrown away, which is why the charts could never show them.
 *
 * Deliberately never records a session id: a failed request contributes nothing to per-session
 * analytics, and this keeps the anonymization surface unchanged.
 */
export async function recordOutcome(p: RecordOutcomeParams): Promise<void> {
  emit({
    id:             randomUUID(),
    sessionId:      '',
    modelId:        p.modelName ?? '',
    modelName:      p.modelName ?? '',
    provider:       p.provider  ?? '',
    inputTokens:    0,
    outputTokens:   0,
    totalTokens:    0,
    unit:           'token',
    quantity:       0,
    estimatedUsd:   0,
    outcome:        p.outcome,
    latencyMs:      Math.max(0, Math.round(p.latencyMs)),
    cached:         false,
    savedUsd:       0,
    nexusTeamKeyId: p.nexusTeamKeyId ?? null,
    createdAt:      new Date(),
  });
}

// Fire-and-forget operator alert (Phase 6.4b) when a team's spend crosses 80% or 100% of its
// budget for the window. The crossing test is pure, so the team-name lookup only runs on the rare
// request that actually vaults a threshold — and a crossing happens at most twice per team per
// budget window by construction. Never awaited by recordTokenUsage. (7.11 dropped the armed check:
// it gated on the email config, so a team quietly burning its budget would never have reached the
// in-app feed unless email was configured.)
async function alertBudgetThreshold(
  teamId: string, period: BudgetPeriod, previous: number, next: number, budgetUsd: number,
): Promise<void> {
  const pct = budgetThresholdCrossed(previous, next, budgetUsd);
  if (!pct) return;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
  await notify(budgetThresholdMessage({
    teamId, teamName: team?.name ?? teamId, pct,
    spendUsd: next, budgetUsd, period, windowId: periodKey(period),
  }));
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
    prisma.$queryRaw<{ day: Date; tokens: number; inputTokens: number; outputTokens: number; requests: number; usd: number }[]>`
      SELECT date_trunc('day', "createdAt") AS day,
             SUM("totalTokens")::float8    AS tokens,
             SUM("inputTokens")::float8    AS "inputTokens",
             SUM("outputTokens")::float8   AS "outputTokens",
             COUNT(*)::int                 AS requests,
             SUM("estimatedUsd")::float8   AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,
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
    date:         new Date(r.day).toISOString().slice(0, 10),
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

export async function getTimeSeriesByTeam(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  // Day × team-key buckets, aggregated in Postgres. The JOIN both attaches the display name
  // and enforces "team traffic only" (a null team-key id cannot match). `teamId` preserves the
  // existing shape, which labels the team-*key* id as teamId.
  const rows = await prisma.$queryRaw<{ day: Date; teamKeyId: string; teamName: string; requests: number; tokens: number }[]>`
    SELECT date_trunc('day', u."createdAt") AS day,
           u."nexusTeamKeyId"               AS "teamKeyId",
           k."name"                         AS "teamName",
           COUNT(*)::int                    AS requests,
           SUM(u."totalTokens")::float8     AS tokens
    FROM "TokenUsage" u
    JOIN "NexusTeamKey" k ON k.id = u."nexusTeamKeyId"
    WHERE u."createdAt" >= ${since} AND u."createdAt" <= ${until}
    GROUP BY day, u."nexusTeamKeyId", k."name"
    ORDER BY day ASC`;

  return rows.map((r) => ({
    date:      new Date(r.day).toISOString().slice(0, 10),
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
  const rows = await prisma.$queryRaw<{ day: Date; model: string; tokens: number }[]>`
    SELECT date_trunc('day', "createdAt") AS day,
           "modelName"                    AS model,
           SUM("totalTokens")::float8     AS tokens
    FROM "TokenUsage"
    WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
    GROUP BY day, "modelName"
    ORDER BY day ASC`;

  return rows.map((r) => ({
    date:   new Date(r.day).toISOString().slice(0, 10),
    model:  r.model,
    tokens: r.tokens ?? 0,
  }));
}
