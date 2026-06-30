import { prisma }       from '../lib/prisma';
import { calculateCost } from './model.service';
import type { AiModel }  from './model.service';
import { randomUUID }   from 'crypto';

export interface RecordTokenUsageParams {
  sessionId:    string;
  model:        AiModel;
  inputTokens:  number;
  outputTokens: number;
}

export async function recordTokenUsage(p: RecordTokenUsageParams): Promise<void> {
  const total       = p.inputTokens + p.outputTokens;
  const estimatedUsd = calculateCost(p.model, p.inputTokens, p.outputTokens);
  await prisma.tokenUsage.create({
    data: {
      id:           randomUUID(),
      sessionId:    p.sessionId,
      modelId:      p.model.id,
      modelName:    p.model.displayName,
      provider:     p.model.provider,
      inputTokens:  p.inputTokens,
      outputTokens: p.outputTokens,
      totalTokens:  total,
      estimatedUsd,
    },
  });
}

export async function getUsageSummary(period: 'today' | '7d' | '30d') {
  const now = new Date();
  let since: Date;
  if (period === 'today') {
    since = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  } else if (period === '7d') {
    since = new Date(Date.now() - 7 * 86400000);
  } else {
    since = new Date(Date.now() - 30 * 86400000);
  }

  const rows = await prisma.tokenUsage.findMany({ where: { createdAt: { gte: since } } });
  const totals = rows.reduce(
    (acc, r) => ({
      inputTokens:  acc.inputTokens  + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      totalTokens:  acc.totalTokens  + r.totalTokens,
      estimatedUsd: acc.estimatedUsd + r.estimatedUsd,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0 },
  );

  const byModel: Record<string, { tokens: number; usd: number }> = {};
  for (const r of rows) {
    if (!byModel[r.modelId]) byModel[r.modelId] = { tokens: 0, usd: 0 };
    byModel[r.modelId].tokens += r.totalTokens;
    byModel[r.modelId].usd   += r.estimatedUsd;
  }

  // Daily breakdown
  const dayMap = new Map<string, number>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + r.totalTokens);
  }
  const byDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tokens]) => ({ date, tokens }));

  return { period, since: since.toISOString(), totals, byModel, byDay };
}
