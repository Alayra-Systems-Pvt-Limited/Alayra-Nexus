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

import type { ProviderRow } from '../../core/ports';
import { getStickyKeyId } from '../../lib/sticky';
import { costOrder, effectivePrice } from '../../lib/routing';
import { selectModels, type SelectableModel, type Capability } from '../../lib/modelSelect';
import type { RoutingScope } from '../../lib/scope';
import { getCostWeight } from '../routing.service';
import { getModelRegistry, activeProviderSlugs } from '../model.service';
import { getActiveProviders } from '../providerCache.service';
import { tryPickKey, tryStickyKey } from './pickKey';
import { SHARED_SCOPE, TIER_ORDER, type NexusRoute, type RouteModel } from './route';

// ── Discovery: which model, which pool, which key ─────────────────────────────

/**
 * Model-first sweep (Phase 6.1). Walk `candidates` (already ordered best-first by
 * tier → priority → cost), and for each model try every active pool for its provider.
 * The key mechanics — breaker gate, atomic admission, BYOK ownership filter — are
 * exactly those of the pool-tier router; only the outer selection changed.
 *
 * `ownerTeamId` scopes which keys are eligible, so the BYOK own-keys pass and the
 * shared-pool pass reuse this function unchanged.
 */
async function sweepModels(
  candidates: SelectableModel[],
  reserveTokens: number,
  ownerTeamId: string | null,
  userId: string | null,
): Promise<NexusRoute | null> {
  let higherTierWasExhausted = false;
  let currentTier = candidates[0]?.tier;

  // Load every candidate provider's pools once, then group in memory, rather than a findMany per
  // candidate (an N+1 on the routing hot path — the same provider recurs across many candidates).
  // The global createdAt ordering is preserved within each provider group, so selection is unchanged.
  //
  // The pools come from the shared cache rather than a query. Filtering an already-ordered list
  // cannot reorder it, so this selects the same pools in the same sequence the `where … in` did.
  const providerSlugs = new Set(candidates.map((c) => c.provider));
  const allPools = providerSlugs.size
    ? (await getActiveProviders()).filter((p) => providerSlugs.has(p.provider))
    : [];
  const poolsByProvider = new Map<string, typeof allPools>();
  for (const pool of allPools) {
    const existing = poolsByProvider.get(pool.provider);
    if (existing) existing.push(pool);
    else poolsByProvider.set(pool.provider, [pool]);
  }

  for (const m of candidates) {
    // Track tier transitions so wasDowngrade means "a better tier was attempted and
    // yielded nothing", matching the pool-tier router's semantics.
    if (m.tier !== currentTier) { higherTierWasExhausted = true; currentTier = m.tier; }

    const pools = poolsByProvider.get(m.provider) ?? [];
    const routeModel: RouteModel = { modelString: m.modelString, modelId: m.id, tier: m.tier };
    for (const pool of pools) {
      const route = await tryPickKey(pool, reserveTokens, ownerTeamId, routeModel, userId);
      if (route) return { ...route, wasDowngrade: higherTierWasExhausted, sticky: false };
    }
  }
  return null;
}

/** Price lookup for cost-aware ordering. Built once per discovery, reused per pass. */
type PriceOf = (p: { preferredModel: string | null }) => number | null;

/**
 * Legacy fallback: the pre-6.1 pool-tier walk, using each pool's own `preferredModel`.
 * Reached only for `chat` when the registry has no eligible model — a safety net for a
 * deployment whose pools exist but whose registry has not been populated (boot-seed
 * runs at startup, so this is rare). Never used by non-chat endpoints.
 */
async function legacySweepTiers(
  reserveTokens: number,
  ownerTeamId: string | null,
  costWeight: number,
  priceOf: PriceOf,
  userId: string | null,
): Promise<NexusRoute | null> {
  let higherTierWasExhausted = false;

  const active = await getActiveProviders();

  for (const tier of TIER_ORDER) {
    // Same rows, same createdAt order, filtered in memory — see sweepModels.
    const providers = active.filter((p) => p.tier === tier);

    const ordered = costWeight > 0 ? costOrder(providers, priceOf, costWeight) : providers;

    for (const provider of ordered) {
      const model: RouteModel = { modelString: provider.preferredModel ?? '', modelId: null, tier };
      const route = await tryPickKey(provider, reserveTokens, ownerTeamId, model, userId);
      if (route) return { ...route, wasDowngrade: higherTierWasExhausted, sticky: false };
    }

    if (providers.length > 0) higherTierWasExhausted = true;
  }
  return null;
}

/**
 * Find the best available key, atomically reserving `reserveTokens` (estimated
 * input + max output) against the chosen key's TPM budget. When `sessionKey` is
 * given, a continuing conversation is pinned to the key that last served it so the
 * provider's prompt cache is reused; otherwise, and on any sticky miss, selection
 * falls back to tier order with LRU within a tier.
 *
 * `scope` (Phase 5.5) decides which keys are eligible. A BYOK team sweeps its own
 * keys first and only then — if it permits fall-back — the shared pool. A team with
 * fall-back disabled is hard-isolated: null is returned rather than a pooled key.
 *
 * Returns null when every eligible key is out of RPM or TPM headroom.
 */
export async function discoverBestPool(
  reserveTokens: number,
  sessionKey?: string | null,
  scope: RoutingScope = SHARED_SCOPE,
  capability: Capability = 'chat',
  userId: string | null = null,
  preferredTier: string | null = null,
  pinnedModelId: string | null = null,
  costWeightOverride?: number,
): Promise<NexusRoute | null> {
  const costWeight = costWeightOverride ?? await getCostWeight();
  const registry   = await getModelRegistry();

  // Model-first candidate list (Phase 6.1): the registry, filtered to this capability
  // and to providers that actually have a pool, ordered tier → priority → cost. When the
  // caller is a team with an assigned tier (Phase 8), that tier leads the ordering.
  const priceById = new Map<string, number | null>();
  for (const m of registry) priceById.set(m.id, effectivePrice(m as unknown as Record<string, unknown>));
  const ordered = selectModels(registry as unknown as SelectableModel[], {
    capability,
    activeProviderSlugs: await activeProviderSlugs(),
    priceOf: (m) => priceById.get(m.id) ?? null,
    costWeight,
    preferredTier,
  });

  // A pinned request narrows the candidate list to the one model the caller named, and to
  // nothing else. Failover across that provider's KEYS is untouched — a pin gives up
  // cross-model failover, which is the caller's decision, not ours to quietly override by
  // answering with a model they did not ask for.
  const candidates = pinnedModelId ? ordered.filter((m) => m.id === pinnedModelId) : ordered;

  // The legacy pool-tier path is used only for chat when no registry model qualifies. A
  // pinned request never takes it: falling back to a pool's own preferred model is exactly
  // the substitution a pin exists to forbid.
  const allowLegacyChat = capability === 'chat' && candidates.length === 0 && !pinnedModelId;

  // The model a sticky pin should serve: the registry candidate for its provider, or —
  // on the legacy path — the pinned pool's own preferred model. Reusing the *key*
  // preserves the provider's prompt cache; the registry still decides the model string.
  const pickModel = (provider: ProviderRow): RouteModel | null => {
    const m = candidates.find((c) => c.provider === provider.provider);
    if (m) return { modelString: m.modelString, modelId: m.id, tier: m.tier };
    if (allowLegacyChat && provider.preferredModel) {
      return { modelString: provider.preferredModel, modelId: null, tier: provider.tier };
    }
    return null;
  };

  // Sticky cache-affinity is resolved first and always wins over the cost tiebreaker:
  // a cache hit on a slightly pricier provider usually beats a miss on the cheapest.
  if (sessionKey) {
    const stickyKeyId = await getStickyKeyId(sessionKey);
    if (stickyKeyId) {
      const stickyRoute = await tryStickyKey(stickyKeyId, reserveTokens, scope, pickModel, userId);
      if (stickyRoute) return stickyRoute;
    }
  }

  if (candidates.length > 0) {
    // Pass 1 — the team's own keys, when it has any.
    if (scope.ownerTeamId) {
      const owned = await sweepModels(candidates, reserveTokens, scope.ownerTeamId, userId);
      if (owned) return owned;
    }
    // Hard isolation: exhausting your own keys is a 503, not a silent hand-off to
    // credentials you did not bring. Checked outside the owner test so that a scope which
    // forbids the pool never reaches it, whatever its owner id (byok-only, P1.1).
    if (!scope.fallbackToShared) return null;
    // Pass 2 — the shared pool.
    return sweepModels(candidates, reserveTokens, null, userId);
  }

  // ── Legacy fallback (chat only) ──
  // No registry model is eligible. For chat, fall back to the pre-6.1 pool-tier walk so
  // a deployment whose pools exist but whose registry is empty still serves traffic
  // (boot-seed normally prevents this). Non-chat capabilities have no legacy path.
  if (capability !== 'chat') return null;
  // …and neither does a pinned request. The walk below substitutes each pool's own
  // preferred model, which is exactly the substitution a pin forbids: the caller asked for
  // one model, and would silently be answered by another.
  if (pinnedModelId) return null;

  let priceOf: PriceOf = () => null;
  if (costWeight > 0) {
    const prices = new Map<string, number | null>();
    for (const m of registry as unknown as Record<string, unknown>[]) {
      const price = effectivePrice(m);
      if (typeof m.modelString === 'string') prices.set(m.modelString, price);
      if (typeof m.id === 'string')          prices.set(m.id, price);
    }
    priceOf = (p) => (p.preferredModel ? prices.get(p.preferredModel) ?? null : null);
  }

  if (scope.ownerTeamId) {
    const owned = await legacySweepTiers(reserveTokens, scope.ownerTeamId, costWeight, priceOf, userId);
    if (owned) return owned;
  }
  if (!scope.fallbackToShared) return null;
  return legacySweepTiers(reserveTokens, null, costWeight, priceOf, userId);
}
