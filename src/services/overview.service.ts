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

// Overview aggregate (Phase 7.2): the single read the redesigned landing screen makes. Composing
// it here — rather than having the dashboard fire six requests on load — keeps the page a single
// round-trip and puts the "what the overview needs" decision in one owned place. It only reads;
// each figure comes from an existing service or a bounded count, so nothing new about how usage or
// audit data is produced lives here.

import { prisma } from '../lib/prisma';
import { getUsageSummary, getUsageByTeamKey } from './token.service';
import { queryAuditLogs } from './audit.service';
import { getModelRegistry } from './model.service';

const TOP_N       = 5;
const RECENT_LOGS = 8;
const WINDOW_DAYS = 7;

export interface OverviewStats {
  totalRequests:  number; // all-time
  totalCostUsd:   number; // all-time
  inputTokens7d:  number;
  outputTokens7d: number;
  activeKeys:     number; // usable provider keys across the pools
  activeModels:   number; // entries in the live model registry
  activeTeams:    number; // teams that hold at least one access key
}

export interface OverviewDay {
  date: string; inputTokens: number; outputTokens: number; tokens: number; usd: number; requests: number;
}

export interface OverviewPayload {
  stats:      OverviewStats;
  series7d:   OverviewDay[];
  topModels:  { model: string; tokens: number; usd: number }[];
  topKeys:    { id: string; name: string; totalTokens: number; requests: number; estimatedUsd: number }[];
  recentLogs: { id: string; action: string; method: string; actorRole: string; status: number; target: string | null; createdAt: string }[];
}

/** The UTC dates of the last `WINDOW_DAYS` days, oldest first — so the chart always shows a full week. */
function windowDates(now: Date): string[] {
  const out: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Project the (gap-prone) day buckets onto a full week, filling absent days with zeros. */
function fillWindow(byDay: OverviewDay[], now: Date): OverviewDay[] {
  const found = new Map(byDay.map((d) => [d.date, d]));
  return windowDates(now).map((date) =>
    found.get(date) ?? { date, inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0, requests: 0 },
  );
}

export async function getOverview(now = new Date()): Promise<OverviewPayload> {
  const [summary7d, topKeys, logs, registry, allTime, keyRows, activeTeams] = await Promise.all([
    getUsageSummary('7d'),
    getUsageByTeamKey('7d'),
    queryAuditLogs({ limit: RECENT_LOGS }),
    getModelRegistry().catch(() => []),
    prisma.tokenUsage.aggregate({ _count: { _all: true }, _sum: { estimatedUsd: true } }),
    prisma.nexusKey.findMany({ select: { status: true, coolingUntil: true } }),
    prisma.team.count({ where: { teamKeys: { some: {} } } }),
  ]);

  const activeKeys = keyRows.filter(
    (k) => k.status === 'active' && (!k.coolingUntil || k.coolingUntil <= now),
  ).length;

  const topModels = Object.entries(summary7d.byModel)
    .map(([model, v]) => ({ model, tokens: v.tokens, usd: v.usd }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_N);

  return {
    stats: {
      totalRequests:  allTime._count._all ?? 0,
      totalCostUsd:   allTime._sum.estimatedUsd ?? 0,
      inputTokens7d:  summary7d.totals.inputTokens,
      outputTokens7d: summary7d.totals.outputTokens,
      activeKeys,
      activeModels:   registry.length,
      activeTeams,
    },
    series7d: fillWindow(summary7d.byDay, now),
    topModels,
    topKeys: topKeys.slice(0, TOP_N).map((k) => ({
      id: k.id, name: k.name, totalTokens: k.totalTokens, requests: k.requests, estimatedUsd: k.estimatedUsd,
    })),
    recentLogs: logs.map((l) => ({
      id: l.id, action: l.action, method: l.method, actorRole: l.actorRole,
      status: l.status, target: l.target, createdAt: l.createdAt.toISOString(),
    })),
  };
}
