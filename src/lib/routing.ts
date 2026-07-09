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

// ── Cost-aware routing ────────────────────────────────────────────────────────
// A cost tiebreaker layered on top of the Phase 3 router. It reorders the
// candidate providers *within a tier* by price, so the cheapest capable, healthy,
// in-headroom provider is tried first — without ever overriding correctness. Cost
// is applied only in the fallback tier loop, after sticky-cache preference, and
// each reordered candidate still passes through the breaker + admission gates, so
// an ineligible (cooling / over-limit) provider is skipped no matter how cheap it
// is. Capability (tier order) is never crossed; cost only breaks ties inside a tier.

/**
 * Relative price signal for a model, in cost-per-1k-tokens units (input + output
 * summed — a monotonic proxy for "how expensive is this provider", not a billing
 * figure). Tolerates both the per-1k and per-1M registry formats. Returns null
 * when the model carries no pricing, so unpriced providers can be ranked last
 * without being treated as free.
 */
export function effectivePrice(model: Record<string, unknown> | undefined | null): number | null {
  if (!model) return null;
  const i1k = model.inputPricePer1k  as number | undefined;
  const o1k = model.outputPricePer1k as number | undefined;
  const i1m = model.inputCostPer1M   as number | undefined;
  const o1m = model.outputCostPer1M  as number | undefined;

  const hasK = typeof i1k === 'number' || typeof o1k === 'number';
  const hasM = typeof i1m === 'number' || typeof o1m === 'number';
  if (!hasK && !hasM) return null;

  const input  = typeof i1k === 'number' ? i1k : (typeof i1m === 'number' ? i1m / 1000 : 0);
  const output = typeof o1k === 'number' ? o1k : (typeof o1m === 'number' ? o1m / 1000 : 0);
  return input + output;
}

/** Clamp an operator-supplied cost weight into the valid [0, 1] range. */
export function clampCostWeight(w: unknown): number {
  const n = typeof w === 'number' ? w : Number(w);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Reorder items by a blend of their original order and their price order. The blend
 * is rank-based so it needs no second numeric axis: each item has an original rank
 * and a cost rank, and the sort key is `(1-w)*origRank + w*costRank`.
 *
 *   w = 0  → original order unchanged (cost ignored)
 *   w = 1  → strict cheapest-first
 *   0<w<1  → interpolated, biasing toward cheaper without ignoring operator order
 *
 * Unpriced items (priceOf → null) rank last among peers but keep their relative
 * order, so enabling cost routing never silently drops a provider with no price.
 * Pure and stable — ties fall back to original order.
 */
export function costOrder<T>(items: T[], priceOf: (t: T) => number | null, costWeight: number): T[] {
  const w = clampCostWeight(costWeight);
  if (w === 0 || items.length < 2) return items.slice();

  const enriched = items.map((item, origRank) => ({ item, origRank, price: priceOf(item) }));

  const byPrice = [...enriched].sort((a, b) => ((a.price ?? Infinity) - (b.price ?? Infinity)) || (a.origRank - b.origRank));
  const costRank = new Map<number, number>();
  byPrice.forEach((e, i) => costRank.set(e.origRank, i));

  return [...enriched]
    .sort((a, b) => {
      const sa = (1 - w) * a.origRank + w * (costRank.get(a.origRank) ?? 0);
      const sb = (1 - w) * b.origRank + w * (costRank.get(b.origRank) ?? 0);
      return (sa - sb) || (a.origRank - b.origRank);
    })
    .map((e) => e.item);
}
