import { prisma }          from '../lib/prisma';
import { randomUUID }      from 'crypto';
import { getModelRegistry } from './model.service';

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

export interface RecordTokenUsageParams {
  sessionId:       string;
  modelId:         string;
  modelName:       string;
  provider:        string;
  inputTokens:     number;
  outputTokens:    number;
  nexusTeamKeyId?: string;
}

export async function recordTokenUsage(p: RecordTokenUsageParams): Promise<void> {
  let estimatedUsd = 0;
  try {
    const registry = await getModelRegistry();
    const m = registry.find(r => r.modelString === p.modelName || r.id === p.modelId) as Record<string, unknown> | undefined;
    if (m) estimatedUsd = modelCost(m, p.inputTokens, p.outputTokens);
  } catch { /* non-fatal — never block a proxy request */ }

  await prisma.tokenUsage.create({
    data: {
      id:             randomUUID(),
      sessionId:      p.sessionId,
      modelId:        p.modelId,
      modelName:      p.modelName,
      provider:       p.provider,
      inputTokens:    p.inputTokens,
      outputTokens:   p.outputTokens,
      totalTokens:    p.inputTokens + p.outputTokens,
      estimatedUsd,
      nexusTeamKeyId: p.nexusTeamKeyId ?? null,
    },
  });
}

export async function getUsageSummary(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const rows  = await prisma.tokenUsage.findMany({ where: { createdAt: { gte: since, lte: until } } });

  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0 };
  const byModel:    Record<string, { inputTokens: number; outputTokens: number; tokens: number; usd: number; requests: number }> = {};
  const byProvider: Record<string, { tokens: number; usd: number; requests: number }> = {};
  const dayMap    = new Map<string, { tokens: number; requests: number; usd: number }>();

  for (const r of rows) {
    totals.requests     += 1;
    totals.inputTokens  += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.totalTokens  += r.totalTokens;
    totals.estimatedUsd += r.estimatedUsd;

    byModel[r.modelName] ??= { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0, requests: 0 };
    byModel[r.modelName].inputTokens  += r.inputTokens;
    byModel[r.modelName].outputTokens += r.outputTokens;
    byModel[r.modelName].tokens       += r.totalTokens;
    byModel[r.modelName].usd          += r.estimatedUsd;
    byModel[r.modelName].requests     += 1;

    byProvider[r.provider] ??= { tokens: 0, usd: 0, requests: 0 };
    byProvider[r.provider].tokens   += r.totalTokens;
    byProvider[r.provider].usd      += r.estimatedUsd;
    byProvider[r.provider].requests += 1;

    const day = r.createdAt.toISOString().slice(0, 10);
    const de  = dayMap.get(day) ?? { tokens: 0, requests: 0, usd: 0 };
    de.tokens   += r.totalTokens;
    de.requests += 1;
    de.usd      += r.estimatedUsd;
    dayMap.set(day, de);
  }

  const byDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d }));

  return { period, since: since.toISOString(), totals, byModel, byProvider, byDay };
}

export async function getUsageByTeamKey(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const rows  = await prisma.tokenUsage.findMany({
    where:   { createdAt: { gte: since, lte: until }, nexusTeamKeyId: { not: null } },
    include: { teamKey: { select: { id: true, name: true } } },
  });

  const byKey: Record<string, { name: string; inputTokens: number; outputTokens: number; totalTokens: number; requests: number; estimatedUsd: number }> = {};
  for (const r of rows) {
    if (!r.teamKey) continue;
    const e = byKey[r.teamKey.id] ??= { name: r.teamKey.name, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, estimatedUsd: 0 };
    e.inputTokens  += r.inputTokens;
    e.outputTokens += r.outputTokens;
    e.totalTokens  += r.totalTokens;
    e.requests     += 1;
    e.estimatedUsd += r.estimatedUsd;
  }

  return Object.entries(byKey)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export async function getTimeSeriesByTeam(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const rows  = await prisma.tokenUsage.findMany({
    where:   { createdAt: { gte: since, lte: until }, nexusTeamKeyId: { not: null } },
    include: { teamKey: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const map = new Map<string, { date: string; teamId: string; teamName: string; requests: number; tokens: number }>();
  for (const r of rows) {
    if (!r.teamKey) continue;
    const date = r.createdAt.toISOString().slice(0, 10);
    const key  = `${date}::${r.teamKey.id}`;
    const e    = map.get(key) ?? { date, teamId: r.teamKey.id, teamName: r.teamKey.name, requests: 0, tokens: 0 };
    e.requests += 1;
    e.tokens   += r.totalTokens;
    map.set(key, e);
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getTimeSeriesByModel(period: Period = '30d', customSince?: Date, customUntil?: Date) {
  const { since, until } = resolveRange(period, customSince, customUntil);
  const rows  = await prisma.tokenUsage.findMany({
    where:   { createdAt: { gte: since, lte: until } },
    orderBy: { createdAt: 'asc' },
    select:  { createdAt: true, modelName: true, totalTokens: true },
  });

  const map = new Map<string, { date: string; model: string; tokens: number }>();
  for (const r of rows) {
    const date = r.createdAt.toISOString().slice(0, 10);
    const key  = `${date}::${r.modelName}`;
    const e    = map.get(key) ?? { date, model: r.modelName, tokens: 0 };
    e.tokens += r.totalTokens;
    map.set(key, e);
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
