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

// ── The price of one token request ──────────────────────────────────────────────────────────────
//
// Input and output at the model's two prices, plus what a provider bills on top: prompt-cache reads
// and writes at their own rates, and server tools billed per use. The figure feeds the usage row's
// `estimatedUsd` and the team budget, so a rate that is too high blocks a team early and one that is
// too low lets it overspend. When unsure, it errs high.
//
// Cache rates come from the registry entry when set. Otherwise, for Anthropic only, they follow
// Anthropic's published multipliers of the input price (read 0.1x, 5-minute write 1.25x, 1-hour
// write 2x; https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching). Models that
// read cache at a different rate carry their own figure in the registry. Every other provider is
// priced exactly as before: all input at the input price.

import type { UsageDetail } from './usageDetail';

/** Optional per-model prices beyond input and output, in USD. Absent means not set, never zero. */
export interface ExtraPrices {
  cacheReadCostPer1M?:    number;
  cacheWrite5mCostPer1M?: number;
  cacheWrite1hCostPer1M?: number;
  /** Per 1,000 uses of a server tool the provider runs and bills per use. */
  webSearchCostPer1K?:    number;
  webFetchCostPer1K?:     number;
}

export const EXTRA_PRICE_FIELDS = [
  'cacheReadCostPer1M', 'cacheWrite5mCostPer1M', 'cacheWrite1hCostPer1M', 'webSearchCostPer1K', 'webFetchCostPer1K',
] as const satisfies ReadonlyArray<keyof ExtraPrices>;

/** The prices a registry entry sets, keeping only real ones (finite, not negative). */
export function readExtraPrices(raw: Record<string, unknown>): ExtraPrices {
  const out: ExtraPrices = {};
  for (const f of EXTRA_PRICE_FIELDS) {
    const v = raw[f];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[f] = v;
  }
  return out;
}

/** Anthropic's prompt-cache multipliers of the input price (see the link above). */
const ANTHROPIC_CACHE = { read: 0.1, write5m: 1.25, write1h: 2 } as const;

/**
 * Server tools a provider bills per use AND reports in `usage.server_tool_use`, keyed by the tool
 * family (the tool type without its date). Only these can be metered; any other server tool is
 * stripped from a native request (proxy/anthropicPolicy.ts). Web search is $10 per 1,000 searches and
 * web fetch has no charge beyond tokens on Anthropic's API; the operator sets both per model.
 */
export const METERED_SERVER_TOOLS = {
  web_search: { counter: 'web_search_requests', price: 'webSearchCostPer1K' },
  web_fetch:  { counter: 'web_fetch_requests',  price: 'webFetchCostPer1K' },
} as const satisfies Record<string, { counter: string; price: keyof ExtraPrices }>;

export type ServerToolFamily = keyof typeof METERED_SERVER_TOOLS;

/** Server-tool use as reported: counter name (`web_search_requests`) to count. */
export type ServerToolUse = Record<string, number>;

/** Is this server tool priced on this model, so that its use can be recorded and budgeted? */
export function serverToolPriced(m: Record<string, unknown> | undefined, family: string): boolean {
  const spec = (METERED_SERVER_TOOLS as Record<string, { price: keyof ExtraPrices }>)[family];
  return !!spec && !!m && readExtraPrices(m)[spec.price] !== undefined;
}

const per1M = (m: Record<string, unknown>, side: 'input' | 'output'): number => {
  const per1k = m[`${side}PricePer1k`];
  if (typeof per1k === 'number') return per1k * 1000;          // the registry's older field
  const v = m[`${side}CostPer1M`];
  return typeof v === 'number' ? v : 0;
};

/**
 * USD for one token request. `input` is the whole prompt (uncached plus cache reads plus cache
 * writes); `detail` says how much of it was which. A cache-write total reported without its 5-minute
 * and 1-hour split is priced at the 1-hour rate, the higher of the two.
 */
export function tokenCost(
  m: Record<string, unknown>, provider: string, input: number, output: number,
  detail?: UsageDetail, serverToolUse?: ServerToolUse,
): number {
  const inPrice = per1M(m, 'input');
  const extra = readExtraPrices(m);
  const anthropic = provider === 'anthropic';
  const ownRates = extra.cacheReadCostPer1M !== undefined || extra.cacheWrite5mCostPer1M !== undefined
    || extra.cacheWrite1hCostPer1M !== undefined;

  let inputUsd = input * inPrice;
  if (anthropic || ownRates) {
    const rate = (own: number | undefined, mult: number) => own ?? (anthropic ? inPrice * mult : inPrice);
    const reads = detail?.cachedInputTokens ?? 0;
    const w5m = detail?.cacheWrite5mTokens ?? 0;
    const w1h = detail?.cacheWrite1hTokens ?? 0;
    const writes = Math.max(detail?.cacheWriteTokens ?? 0, w5m + w1h);
    const unsplit = writes - w5m - w1h;
    const uncached = Math.max(0, input - reads - writes);
    inputUsd = uncached * inPrice
      + reads * rate(extra.cacheReadCostPer1M, ANTHROPIC_CACHE.read)
      + w5m * rate(extra.cacheWrite5mCostPer1M, ANTHROPIC_CACHE.write5m)
      + (w1h + unsplit) * rate(extra.cacheWrite1hCostPer1M, ANTHROPIC_CACHE.write1h);
  }

  let toolsUsd = 0;
  for (const spec of Object.values(METERED_SERVER_TOOLS)) {
    const uses = serverToolUse?.[spec.counter] ?? 0;
    const price = extra[spec.price];
    if (uses > 0 && price !== undefined) toolsUsd += (uses / 1000) * price;
  }
  return (inputUsd + output * per1M(m, 'output')) / 1_000_000 + toolsUsd;
}
