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

import { redis }  from '../lib/redis';
import { defineScript } from '../lib/kv/memory';
import { prisma } from '../lib/prisma';

// ── Team budget enforcement ───────────────────────────────────────────────────
// Each team's spend for the current period is tracked in a Redis counter and
// checked on the admission path before any provider work happens. The counter is
// seeded from the real TokenUsage sum on a cache miss, so budgets survive a Redis
// flush and pick up historical spend the moment a cap is first set.
//
// Semantics are check-then-spend: admission compares accumulated spend against the
// cap, and the request's actual cost is added after the response (when real usage
// is known). Requests already in flight when the cap is crossed can therefore
// overshoot it by their own cost — the standard trade for budget caps on a
// streaming gateway, where cost is unknowable up front.

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

// Counter TTLs: a period's key lives slightly past the period so late
// reconciliation still lands, then expires on its own.
export const PERIOD_TTL_SECONDS: Record<BudgetPeriod, number> = {
  daily:   2 * 86400,
  weekly:  9 * 86400,
  monthly: 33 * 86400,
};

function isoWeek(d: Date): { year: number; week: number } {
  // ISO-8601: week 1 contains the first Thursday; weeks start Monday. All UTC.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day  = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

/** Stable identifier for the current budget window (UTC). */
export function periodKey(period: BudgetPeriod, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'monthly') return `${y}-${m}`;
  if (period === 'daily')   return `${y}-${m}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const w = isoWeek(now);
  return `${w.year}-W${String(w.week).padStart(2, '0')}`;
}

/** Start of the current budget window (UTC) — the DB seeding boundary. */
export function periodStart(period: BudgetPeriod, now: Date = new Date()): Date {
  if (period === 'monthly') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (period === 'daily')   return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = now.getUTCDay() || 7; // Monday=1 … Sunday=7
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (day - 1));
  return start;
}

/** Seconds until the current window resets — used as Retry-After on a block. */
export function periodEndSeconds(period: BudgetPeriod, now: Date = new Date()): number {
  let end: Date;
  if (period === 'monthly') end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  else if (period === 'daily') end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  else {
    const start = periodStart('weekly', now);
    end = new Date(start.getTime() + 7 * 86400000);
  }
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

export function budgetRedisKey(teamId: string, pk: string): string {
  return `nexus:budget:${teamId}:${pk}`;
}

// Add spend only if the window counter already exists. If it doesn't, the next
// admission check seeds it from the TokenUsage sum — which includes this request
// once the usage pipeline flushes — so a stale partial counter is never created.
export const ADD_SPEND_LUA = defineScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
end
return false
`, ([budgetKey], [usd], kv) => {
  // Two return shapes to honour exactly, and both are easy to get subtly wrong:
  //
  //   • INCRBYFLOAT answers a STRING in Redis, and the caller does parseFloat(String(res)).
  //   • Lua `false` arrives in JS as NULL, and the caller tests `res == null`. Returning JS `false`
  //     here would pass that test (`false == null` is false) and then parseFloat('false') → NaN,
  //     silently corrupting the running spend total.
  if (kv.exists(budgetKey) === 1) return kv.incrbyfloat(budgetKey, Number(usd));
  return null;
});

/**
 * Current-period spend for a team, in USD. Redis-backed; on a miss the counter is
 * seeded from the real TokenUsage sum for the window, so history is never lost.
 */
export async function getCurrentSpend(teamId: string, period: BudgetPeriod, now: Date = new Date()): Promise<number> {
  const key    = budgetRedisKey(teamId, periodKey(period, now));
  const cached = await redis.get(key);
  if (cached !== null) return parseFloat(cached) || 0;

  const agg = await prisma.tokenUsage.aggregate({
    _sum:  { estimatedUsd: true },
    where: { createdAt: { gte: periodStart(period, now) }, teamKey: { teamId } },
  });
  const spend = agg._sum.estimatedUsd ?? 0;
  // NX: if a concurrent request seeded first, keep its counter (it may already
  // include increments this SET would otherwise erase).
  await redis.set(key, String(spend), 'EX', PERIOD_TTL_SECONDS[period], 'NX');
  return spend;
}

/**
 * Record a completed request's cost against the team's current window, returning the new
 * running total (USD) for the window — or null when nothing was added: a zero/negative cost,
 * or a counter that did not yet exist (the Lua guard declines to seed a stale partial). The
 * total lets the caller detect a budget-threshold crossing without a second read; a null
 * simply means "no reliable total this time", and the caller skips the threshold check.
 */
export async function addSpend(teamId: string, period: BudgetPeriod, usd: number, now: Date = new Date()): Promise<number | null> {
  if (!(usd > 0)) return null;
  // INCRBYFLOAT returns the new total (a string) when the counter exists; the else branch
  // returns Lua false, which arrives here as null.
  const res = await redis.eval(ADD_SPEND_LUA, 1, budgetRedisKey(teamId, periodKey(period, now)), String(usd));
  if (res == null) return null;
  const total = parseFloat(String(res));
  return Number.isFinite(total) ? total : null;
}

// What a team does once its period cap is reached (Phase 7.10). "block" is the historical behaviour
// — a hard refusal until the window resets. "notify" is a soft cap: the request is admitted anyway
// (the 80%/100% alert still fires elsewhere), so a budget is a warning line, not a wall. "downgrade"
// keeps serving but forces the cheapest tier, trading model quality for continued availability.
export type OverBudgetAction = 'block' | 'notify' | 'downgrade';

export interface BudgetVerdict {
  allowed:           boolean;       // false only when over budget AND the action is "block"
  downgrade:         boolean;       // true when over budget AND the action is "downgrade"
  spendUsd:          number;
  budgetUsd:         number | null;
  retryAfterSeconds: number;
}

/**
 * Admission check: is this team still inside its budget window, and if not, what should happen?
 * The chosen `overBudgetAction` only matters once spend has reached the cap — under budget, every
 * action behaves identically (admitted, no downgrade). Defaults to "block" so a caller that omits it
 * (and every pre-7.10 test) keeps the original hard-cap semantics.
 */
export async function checkTeamBudget(
  teamId: string,
  budgetUsd: number | null,
  period: BudgetPeriod,
  overBudgetAction: OverBudgetAction = 'block',
  now: Date = new Date(),
): Promise<BudgetVerdict> {
  if (budgetUsd == null) return { allowed: true, downgrade: false, spendUsd: 0, budgetUsd: null, retryAfterSeconds: 0 };
  const spendUsd   = await getCurrentSpend(teamId, period, now);
  const overBudget = spendUsd >= budgetUsd;
  return {
    allowed:           !overBudget || overBudgetAction !== 'block',
    downgrade:         overBudget && overBudgetAction === 'downgrade',
    spendUsd,
    budgetUsd,
    retryAfterSeconds: periodEndSeconds(period, now),
  };
}
