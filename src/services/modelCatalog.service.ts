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

// ── The model catalogue: what a caller may ask for ────────────────────────────
//
// `GET /v1/models` used to return one hardcoded entry, `alayra-nexus-1`, and the chat
// handler rejected every other value with a 400. So an operator could configure ten
// models in the Models tab, and every client still saw exactly one — the registry they
// curated was invisible to the people using the gateway.
//
// This module is the single answer to "which models can this caller reach", and BOTH
// the listing and the request-time resolution are built from it. That is the point: a
// catalogue derived separately from routing drifts, and a listing that advertises a
// model routing will refuse is worse than no listing at all.
//
// Two things a caller may send:
//
//   auto   — no model, or one of the auto aliases. Nexus picks, and fails over across
//            models and keys. This is the product, and it stays the default.
//   pinned — a real model id (or model string) from the catalogue. Nexus routes only to
//            that model, still rotating and failing over across that provider's keys.
//            Cross-model failover is given up, which is the caller's choice to make.
//
// Anything else is a 400 that names what IS available, rather than a silent substitution.
// Serving a different model than the one asked for is the single failure a gateway must
// never have: it is invisible in the response, in the logs, and in the bill.

import { prisma }                 from '../lib/prisma';
import { getActiveProviders }     from './providerCache.service';
import { getModelRegistry, activeProviderSlugs, type AiModel } from './model.service';
import type { Capability }        from '../lib/modelSelect';
import type { RoutingScope }      from '../lib/scope';

/** The virtual model that means "route for me". Listed first, always available. */
export const AUTO_MODEL_ID = 'alayra-nexus-1';

/** Human name for the auto entry, as it appears in a client's model picker. */
export const AUTO_MODEL_NAME = 'Alayra Nexus (auto-route)';

/**
 * Values that mean "route for me".
 *
 * `kinetic-nexus-1` and `nexus` are backward compatibility for integrations built before
 * the rename — dropping them would break every deployed client. `auto` and `default` are
 * new, and `auto` in particular is not decoration: the dashboard's own Quick Start has
 * always told operators to send `"model": "auto"`, which the gateway then refused with a
 * 400. The first request a new operator copy-pasted failed.
 */
const AUTO_ALIASES = new Set([AUTO_MODEL_ID, 'kinetic-nexus-1', 'nexus', 'auto', 'default']);

export function isAutoModel(raw: string): boolean {
  return AUTO_ALIASES.has(raw.trim().toLowerCase());
}

/** One entry as `/v1/models` serves it. */
export interface CatalogEntry {
  /** What a client sends back as `model`. */
  id:            string;
  displayName:   string;
  /** Provider slug, or 'alayra-nexus' for the auto entry. */
  provider:      string;
  capabilities:  string[];
  contextWindow: number;
  maxTokens:     number;
  /** True for the single auto-route entry. */
  auto:          boolean;
}

export type ModelResolution =
  | { kind: 'auto' }
  | { kind: 'pinned'; model: AiModel }
  | { kind: 'unknown'; requested: string; available: string[] };

/**
 * Provider slugs a team owns at least one usable key for.
 *
 * This is the only team-level model configuration that exists today: a team does not
 * carry a list of permitted models, it carries credentials. A team hard-isolated from
 * the shared pool can therefore only ever be served by providers it brought keys for,
 * and listing anything else would advertise a model that is guaranteed to 503.
 *
 * Banned keys are excluded, cooling ones counted — the breaker may still admit a cooling
 * key as a half-open probe, matching how routing treats them.
 */
async function ownedProviderSlugs(teamId: string): Promise<Set<string>> {
  const rows = await prisma.nexusKey.findMany({
    where:  { ownerTeamId: teamId, status: { in: ['active', 'cooling'] } },
    select: { provider: { select: { provider: true, isActive: true } } },
  });
  return new Set(rows.filter((r) => r.provider.isActive).map((r) => r.provider.provider));
}

/**
 * Which registry models this scope can actually be routed to, in registry order.
 *
 * The filters are deliberately the same three `selectModels` applies — active status, and
 * a provider with a live pool — minus the capability narrowing, because a listing spans
 * every endpoint. A model that fails these is not "hidden", it is unroutable: paused by
 * the operator, or belonging to a pool that no longer exists.
 */
async function servableRegistryModels(scope?: RoutingScope | null): Promise<AiModel[]> {
  const [registry, slugs] = await Promise.all([getModelRegistry(), activeProviderSlugs()]);

  let allowed = slugs;
  // Only a hard-isolated team is narrowed. A team that may fall back to the shared pool
  // can reach every pooled model, so restricting its listing would be a lie in the other
  // direction — it would hide models that will serve it perfectly well.
  if (scope?.ownerTeamId && !scope.fallbackToShared) {
    const owned = await ownedProviderSlugs(scope.ownerTeamId);
    allowed = new Set([...slugs].filter((s) => owned.has(s)));
  }

  return registry.filter((m) => m.status === 'active' && allowed.has(m.provider));
}

/**
 * Pools whose `preferredModel` routing would fall back to.
 *
 * `discoverBestPool` keeps a pre-6.1 pool-tier walk for chat, used only when no registry
 * model qualifies at all. A deployment in that state serves traffic happily while its
 * registry is empty, so a listing built from the registry alone would show nothing for a
 * gateway that plainly works. Mirrors the legacy path's own condition exactly: chat only,
 * and only when the registry produced nothing.
 */
function legacyPoolEntries(providers: Awaited<ReturnType<typeof getActiveProviders>>): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const p of providers) {
    const id = p.preferredModel?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, displayName: id, provider: p.provider,
      capabilities: ['chat'], contextWindow: 0, maxTokens: 0, auto: false,
    });
  }
  return out;
}

/**
 * The catalogue for one caller: the auto entry first, then every model that caller can
 * actually be routed to.
 *
 * Auto is always present, even on a gateway with nothing configured. It is the honest
 * answer to "what can I send you" — the request will 503 with a message about configuring
 * a provider, which is a far better failure than an empty list that reads as a broken
 * endpoint.
 */
export async function listServableModels(scope?: RoutingScope | null): Promise<CatalogEntry[]> {
  const models = await servableRegistryModels(scope);

  const entries: CatalogEntry[] = models.map((m) => ({
    id:            m.id,
    displayName:   m.displayName || m.modelString || m.id,
    provider:      m.provider,
    capabilities:  m.capabilities,
    contextWindow: m.contextWindow,
    maxTokens:     m.maxTokens,
    auto:          false,
  }));

  // The legacy walk's own trigger is "no CHAT-capable model qualifies" — not "the registry
  // is empty". Testing the weaker condition here would let a gateway that has, say, one
  // embedding model registered alongside a chat pool serve chat from that pool while this
  // listing denied any chat model existed.
  if (!models.some((m) => m.capabilities.includes('chat'))) {
    entries.push(...legacyPoolEntries(await getActiveProviders()));
  }

  return [
    { id: AUTO_MODEL_ID, displayName: AUTO_MODEL_NAME, provider: 'alayra-nexus',
      capabilities: [], contextWindow: 0, maxTokens: 0, auto: true },
    ...entries,
  ];
}

/**
 * Resolve what a caller asked for into a routing decision.
 *
 * A pin matches on either the registry id or the model string, case-insensitively, so a
 * client configured with `gpt-4o` reaches the entry an operator named `openai-gpt4o`.
 * `capability` narrows the match to models that can serve the endpoint being called: a
 * transcription model pinned on `/v1/chat/completions` is not a valid pin, and saying so
 * is more useful than routing to it and relaying the provider's own error.
 *
 * The `available` list on a miss is capped — an OpenRouter-backed gateway can hold
 * hundreds of models, and a 400 body is not the place to enumerate them.
 */
export async function resolveRequestedModel(
  raw: string | undefined | null,
  capability: Capability,
  scope?: RoutingScope | null,
): Promise<ModelResolution> {
  const requested = (raw ?? '').trim();
  if (!requested || isAutoModel(requested)) return { kind: 'auto' };

  const wanted  = requested.toLowerCase();
  const models  = await servableRegistryModels(scope);
  const capable = models.filter((m) => m.capabilities.includes(capability));

  const hit = capable.find((m) => m.id.toLowerCase() === wanted)
           ?? capable.find((m) => m.modelString.toLowerCase() === wanted);
  if (hit) return { kind: 'pinned', model: hit };

  // A legacy-path deployment (no chat model in the registry, pools carrying preferredModel)
  // can still be pinned to a pool's own model — the same entries `listServableModels` shows
  // it, under the same condition `discoverBestPool` uses to take that path.
  if (capability === 'chat' && capable.length === 0) {
    const legacy = legacyPoolEntries(await getActiveProviders())
      .find((e) => e.id.toLowerCase() === wanted);
    if (legacy) {
      return { kind: 'pinned', model: {
        id: legacy.id, displayName: legacy.displayName, provider: legacy.provider,
        modelString: legacy.id, tier: 'standard', status: 'active', priority: 2,
        capabilities: ['chat'], hasVision: false, hasFIM: false, hasToolCalling: false,
        inputCostPer1M: 0, outputCostPer1M: 0, imagePrice: 0, speechPricePer1MChars: 0,
        transcriptionPrice: 0, audioInputPer1M: 0, audioOutputPer1M: 0,
        // A legacy pool carries a preferredModel and no registry entry, so there is genuinely
        // nowhere a price could have come from. `unset` rather than a zero that reads as free.
        pricingSource: 'unset',
        contextWindow: 0, maxTokens: 0,
      } };
    }
  }

  return {
    kind: 'unknown',
    requested,
    available: [AUTO_MODEL_ID, ...capable.map((m) => m.id)].slice(0, MAX_LISTED_IN_ERROR),
  };
}

const MAX_LISTED_IN_ERROR = 20;

/**
 * Why a request found no route, in words an operator can act on.
 *
 * Every failure to route used to read "All API keys are currently rate-limited. Retry in
 * Ns or add more provider keys." — including on a gateway with no pools at all, and one
 * with pools but no keys in them. Neither is rate limiting, and neither is fixed by
 * waiting, so the advice sent the operator to look at the wrong thing. This runs only on
 * the 503 path, so the extra count query costs nothing on a healthy request.
 */
export async function noCapacityMessage(opts: {
  isolated:       boolean;
  pinnedModelId:  string | null;
  retryAfter:     number;
}): Promise<string> {
  const { isolated, pinnedModelId, retryAfter } = opts;

  const providers = await getActiveProviders();
  if (providers.length === 0) {
    return 'No provider pools are configured on this gateway. Add a provider and an API key in the Nexus tab before sending requests.';
  }

  const keyCount = await prisma.nexusKey.count({ where: { status: { in: ['active', 'cooling'] } } });
  if (keyCount === 0) {
    return 'No usable provider API keys are configured on this gateway. Add a key to a provider pool in the Nexus tab, or re-enable a banned one.';
  }

  if (pinnedModelId) {
    return `Model "${pinnedModelId}" is configured, but every API key for its provider is rate-limited or cooling. `
         + `Retry in ${retryAfter}s, add another key for that provider, or send "${AUTO_MODEL_ID}" to let Alayra Nexus route across the rest of your models.`;
  }

  // An isolated team must be told the truth: the shared pool was never an option, so
  // "add more provider keys" would be misleading advice.
  return isolated
    ? `Your team's own provider keys are all rate-limited or unavailable, and fall-back to the shared pool is disabled for this team. Retry in ${retryAfter}s or add more keys to your team.`
    : `All API keys are currently rate-limited. Retry in ${retryAfter}s or add more provider keys.`;
}

/** The 400 body for a model this gateway cannot serve. */
export function unknownModelError(res: Extract<ModelResolution, { kind: 'unknown' }>): { error: string; available: string[] } {
  return {
    error: `Unknown model "${res.requested}". Send "${AUTO_MODEL_ID}" to let Alayra Nexus route for you, `
         + `or one of the models this gateway serves — GET /v1/models lists them.`,
    available: res.available,
  };
}
