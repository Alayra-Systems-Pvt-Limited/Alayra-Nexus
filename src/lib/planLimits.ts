// Copyright (c) 2026 Alayra Systems LLC (United States)
//                    Alayra Systems Pvt. Limited (Pakistan)
//                    All rights reserved.
//
// Kinetic IDE is a proprietary product of Alayra Systems.
// Unauthorized reproduction, distribution, or modification
// is strictly prohibited under applicable law.

// ─────────────────────────────────────────────────────────────────
// PLAN LIMITS
// Central configuration for per-tier daily caps and device limits.
// Consumed by quota.service.ts and the scheduler's limit checks.
// ─────────────────────────────────────────────────────────────────

export type PlanTag =
  | 'trial'
  | 'founder'
  | 'pioneer'
  | 'pro_annual'
  | 'standard_lifetime'
  | 'enterprise';

export interface PlanLimits {
  /** Max tokens per calendar day (UTC). null = unlimited. */
  dailyTokenCap:    number | null;
  /** Free-tier tokens included per day before balance is charged. */
  freeTokensPerDay: number;
  /** Maximum number of registered devices. */
  maxDevices:       number;
}

export const PLAN_LIMITS: Record<PlanTag, PlanLimits> = {
  trial:             { dailyTokenCap: 100_000, freeTokensPerDay:  50_000, maxDevices:  2 },
  founder:           { dailyTokenCap: null,    freeTokensPerDay: 100_000, maxDevices:  5 },
  pioneer:           { dailyTokenCap: null,    freeTokensPerDay: 100_000, maxDevices:  5 },
  pro_annual:        { dailyTokenCap: null,    freeTokensPerDay: 100_000, maxDevices: 10 },
  standard_lifetime: { dailyTokenCap: null,    freeTokensPerDay: 100_000, maxDevices: 10 },
  enterprise:        { dailyTokenCap: null,    freeTokensPerDay: 200_000, maxDevices: 50 },
};

/**
 * Returns the plan limits for the given planTag.
 * Falls back to trial limits for unknown tags — never throws.
 */
export function getPlanLimits(planTag: string): PlanLimits {
  return PLAN_LIMITS[planTag as PlanTag] ?? PLAN_LIMITS.trial;
}
