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

// ── byok-only teams: "add a key", not "retry later" (P1.1) ────────────────────────────────────
// A byok-only team (TeamContext.isolation) is served by its own provider keys and nothing else. When
// none of them can serve a request, the honest answer depends on WHY:
//
//   • it owns no usable key for any provider that could serve it → 403 `byok_key_required`. Waiting
//     fixes nothing; adding a key does. A 503 "all keys cooling" would send the caller to retry.
//   • it owns such a key, but every one is busy or cooling     → the normal 503 with Retry-After.
//
// Both checks run only on a refusal path (no route, or an unknown model), so a served request pays
// nothing for them. Neither alerts the gateway operator: a tenant missing its own key is not an
// outage of this gateway.

import { coreStores } from '../core/stores';
import { getModelRegistry, activeProviderSlugs } from './model.service';
import { getActiveProviders } from './providerCache.service';
import { resolveRequestedModel } from './modelCatalog.service';
import { isByokOnly, type RoutingScope } from '../lib/scope';
import type { Capability } from '../lib/modelSelect';
import * as metrics from '../lib/metrics';

/** The stable error code a client can branch on. */
export const BYOK_KEY_REQUIRED = 'byok_key_required';

/** OpenAI's error shape, so an OpenAI SDK surfaces the message and code as they are. */
export interface ByokKeyRequiredBody {
  error: { message: string; type: 'invalid_request_error'; code: typeof BYOK_KEY_REQUIRED; param: null };
}

/** At most this many providers are named in one message. */
const MAX_NAMED = 5;

export function byokKeyRequiredBody(providers: string[]): ByokKeyRequiredBody {
  const named = providers.slice(0, MAX_NAMED).map((p) => `"${p}"`);
  const need = named.length === 0 ? 'a provider API key'
    : named.length === 1 ? `an API key for ${named[0]}`
      : `an API key for one of ${named.join(', ')}`;
  return {
    error: {
      message: 'This team is served only by its own provider keys, and none of them can serve this request. '
             + `Add ${need}, then retry.`,
      type: 'invalid_request_error', code: BYOK_KEY_REQUIRED, param: null,
    },
  };
}

/**
 * What a byok-only caller asked for and could not get. `unknownModel` is a model id the caller's own
 * catalogue does not hold; `pinnedModelId` (null = auto) is a request that found no route.
 */
export type ByokAsk = { unknownModel: string } | { pinnedModelId: string | null };

/**
 * The 403 body when a byok-only scope has no usable key of its own that could serve this request,
 * or null — for every other scope, and when the team's own keys are merely busy.
 */
export async function byokKeyRequired(
  scope: RoutingScope, capability: Capability, ask: ByokAsk,
): Promise<ByokKeyRequiredBody | null> {
  if (!isByokOnly(scope) || scope.ownerTeamId === null) return null;
  const providers = await missingProviders(scope.ownerTeamId, capability, ask);
  if (!providers) return null;
  metrics.byokRequest('isolated_block');
  return byokKeyRequiredBody(providers);
}

/**
 * The providers the team would need a key for, or null when it already owns one that could serve
 * (so the refusal is about capacity, not a missing key). An empty list means "any provider".
 */
async function missingProviders(teamId: string, capability: Capability, ask: ByokAsk): Promise<string[] | null> {
  // Usable = active or cooling, on an active pool: the same test the listing and routing apply.
  const owned = await (await coreStores()).keys.ownedProviderSlugs(teamId);

  // ── A model the team's own catalogue lacks ──
  // It is a 403 only when the gateway does serve that model, through a provider the team has no
  // key for. A model nobody serves stays the ordinary 400 "unknown model".
  if ('unknownModel' in ask) {
    const anywhere = await resolveRequestedModel(ask.unknownModel, capability, null);
    if (anywhere.kind !== 'pinned') return null;
    return owned.has(anywhere.model.provider) ? null : [anywhere.model.provider];
  }

  // ── No route ──
  // A team that owns no usable key at all is always told to add one; the providers that could serve
  // the request are named when they are known.
  const none: string[] | null = owned.size === 0 ? [] : null;
  const [registry, active] = await Promise.all([getModelRegistry(), activeProviderSlugs()]);
  const servable = registry.filter((m) => m.status === 'active' && active.has(m.provider)
    && m.capabilities.includes(capability));

  if (ask.pinnedModelId) {
    const pinned = servable.find((m) => m.id === ask.pinnedModelId);
    const provider = pinned?.provider
      ?? (await getActiveProviders()).find((p) => p.preferredModel === ask.pinnedModelId)?.provider;
    return provider && !owned.has(provider) ? [provider] : none;
  }

  if (servable.length > 0) {
    if (servable.some((m) => owned.has(m.provider))) return null;
    return [...new Set(servable.map((m) => m.provider))];
  }
  // No registry model serves this capability. Chat still has the legacy pool walk, which routes a
  // pool's own preferred model, so an owned key on such a pool is capacity, not a missing key.
  if (capability !== 'chat') return none;
  const pools = (await getActiveProviders()).filter((p) => p.preferredModel);
  if (pools.some((p) => owned.has(p.provider))) return null;
  return [...new Set(pools.map((p) => p.provider))];
}
