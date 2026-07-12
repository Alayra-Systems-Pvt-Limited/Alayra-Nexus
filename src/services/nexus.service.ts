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

import { prisma }           from '../lib/prisma';
import { decrypt, maskKey } from '../lib/encryption';
import { admitKey }         from '../lib/admission';
import * as breaker         from '../lib/breaker';
import { getStickyKeyId }   from '../lib/sticky';
import { costOrder, effectivePrice } from '../lib/routing';
import { getCostWeight }     from './routing.service';
import { getModelRegistry, activeProviderSlugs }  from './model.service';
import { selectModels, type SelectableModel, type Capability } from '../lib/modelSelect';
import { stripTrailingSlash, assertSafeUrl } from '../lib/url';
import { extractModelIds }   from '../lib/modelPath';
import { getSsrfPolicy }     from './ssrf.service';
import { SHARED_NAMESPACE, type RoutingScope } from '../lib/scope';
import { notificationsArmed, notify } from './notifications.service';
import { keyBannedMessage, breakerOpenedMessage, tierExhaustedMessage } from '../lib/notify';

export { maskKey };

/** The scope every caller gets when no team owns keys — the shared pool. */
export const SHARED_SCOPE: RoutingScope = {
  ownerTeamId: null, fallbackToShared: true, namespace: SHARED_NAMESPACE,
};

export type Tier = 'premium' | 'standard' | 'fast';

export const TIER_ORDER: Tier[] = ['premium', 'standard', 'fast'];

export interface NexusRoute {
  keyId:        string;
  decryptedKey: string;
  baseUrl:      string;
  modelString:  string;
  // The registry model id this route serves, when selection came from the registry
  // (Phase 6.1). null on the legacy fallback path. Used so usage/cost is attributed to
  // the real model rather than string-matched against a pool's preferred model.
  modelId:      string | null;
  providerSlug: string;
  tier:         Tier;
  authHeader:   string;
  authPrefix:   string | null;
  wasDowngrade: boolean;
  // True when this request is the single half-open probe for a recovering key —
  // its outcome must be reported so the breaker closes or re-escalates.
  isProbe:      boolean;
  // True when the key was chosen by cache-aware sticky routing rather than LRU.
  sticky:       boolean;
  // True when the key is privately owned by the calling team (BYOK) rather than
  // drawn from the shared pool.
  byok:         boolean;
}

// Provider fields the router needs to build a route from a picked key.
type ProviderRow = {
  id: string; baseUrl: string | null; provider: string;
  authHeader: string; authPrefix: string | null; tier: string; preferredModel: string | null;
};

// The model a route will serve. On the model-first path it comes from the registry; on
// the legacy fallback it is synthesised from the pool's own tier + preferredModel.
type RouteModel = { modelString: string; modelId: string | null; tier: string };

function buildRoute(
  key: { id: string; encryptedKey: string; ownerTeamId: string | null },
  provider: ProviderRow,
  gate: breaker.BreakerGate,
  model: RouteModel,
): Omit<NexusRoute, 'wasDowngrade' | 'sticky'> {
  return {
    keyId:        key.id,
    decryptedKey: decrypt(key.encryptedKey),
    baseUrl:      provider.baseUrl ?? providerDefaultUrl(provider.provider),
    modelString:  model.modelString,
    modelId:      model.modelId,
    providerSlug: provider.provider,
    tier:         (model.tier as Tier),
    authHeader:   provider.authHeader,
    authPrefix:   provider.authPrefix,
    isProbe:      gate === 'probe',
    byok:         key.ownerTeamId !== null,
  };
}

export function providerDefaultUrl(provider: string): string {
  switch (provider) {
    case 'openai':     return 'https://api.openai.com/v1';
    case 'anthropic':  return 'https://api.anthropic.com/v1';
    case 'google':     return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'groq':       return 'https://api.groq.com/openai/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    default:           return '';
  }
}

async function tryPickKey(
  providerRow: ProviderRow,
  reserveTokens: number,
  ownerTeamId: string | null,
  model: RouteModel,
): Promise<Omit<NexusRoute, 'wasDowngrade' | 'sticky'> | null> {
  if (!model.modelString) return null;

  const now  = new Date();
  // Cooling keys are included so the circuit breaker can decide (open vs. probe)
  // — the live gate is breaker.acquire(), not the DB column. Banned keys stay out.
  //
  // `ownerTeamId` scopes the candidate set: null selects the shared pool (keys with
  // no owner), a team id selects only that team's private keys. It is an equality
  // filter, never a superset — a shared-pool caller can never see a BYOK key.
  const keys = await prisma.nexusKey.findMany({
    where:   { providerId: providerRow.id, status: { in: ['active', 'cooling'] }, ownerTeamId },
    orderBy: { lastUsedAt: 'asc' },
  });

  for (const key of keys) {
    // Circuit breaker gate first, so an open (cooling) key never burns RPM/TPM.
    const gate = await breaker.acquire(key.id);
    if (gate === 'open') continue;

    // Atomic RPM + TPM admission. A key at either limit is skipped so the loop
    // rotates to the next key/tier; the caller only fails once every key is
    // exhausted (rotate first, fail last).
    const admitted = await admitKey(key.id, key.rpmLimit, key.tpmLimit, reserveTokens);
    if (!admitted) continue;

    await prisma.nexusKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    return buildRoute(key, providerRow, gate, model);
  }
  return null;
}

/**
 * Try to route to a session's last-successful key (cache-aware sticky routing).
 * Returns null when there is no sticky key, or when it is banned, breaker-open, out of
 * headroom, scope-ineligible, or its provider serves no model for this request's
 * capability — the caller then falls back to normal discovery.
 *
 * `pickModel` maps the pinned key's provider to the model it should serve. This is how
 * sticky reuses the *key* (for the provider's prompt cache) while still honouring the
 * registry as the source of the model string — and, on the legacy path, the pool's own
 * preferred model.
 */
async function tryStickyKey(
  keyId: string,
  reserveTokens: number,
  scope: RoutingScope,
  pickModel: (provider: ProviderRow) => RouteModel | null,
): Promise<NexusRoute | null> {
  const key = await prisma.nexusKey.findUnique({ where: { id: keyId }, include: { provider: true } });
  if (!key || key.status === 'banned' || !key.provider.isActive) return null;

  const model = pickModel(key.provider);
  if (!model) return null;

  // A sticky pin is a Redis session→key mapping that outlives any single request,
  // so it must be re-authorized against this caller's scope. Without this check a
  // session pinned while on the shared pool could resurface that key for an
  // isolated BYOK team (and vice versa). An unusable pin just falls through to
  // normal discovery.
  const eligible = key.ownerTeamId === scope.ownerTeamId
    || (key.ownerTeamId === null && scope.fallbackToShared);
  if (!eligible) return null;

  const gate = await breaker.acquire(key.id);
  if (gate === 'open') return null;

  const admitted = await admitKey(key.id, key.rpmLimit, key.tpmLimit, reserveTokens);
  if (!admitted) return null;

  await prisma.nexusKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return { ...buildRoute(key, key.provider, gate, model), wasDowngrade: false, sticky: true };
}

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
): Promise<NexusRoute | null> {
  let higherTierWasExhausted = false;
  let currentTier = candidates[0]?.tier;

  for (const m of candidates) {
    // Track tier transitions so wasDowngrade means "a better tier was attempted and
    // yielded nothing", matching the pool-tier router's semantics.
    if (m.tier !== currentTier) { higherTierWasExhausted = true; currentTier = m.tier; }

    const pools = await prisma.nexusProvider.findMany({
      where:   { isActive: true, provider: m.provider },
      orderBy: { createdAt: 'asc' },
    });
    const routeModel: RouteModel = { modelString: m.modelString, modelId: m.id, tier: m.tier };
    for (const pool of pools) {
      const route = await tryPickKey(pool, reserveTokens, ownerTeamId, routeModel);
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
): Promise<NexusRoute | null> {
  let higherTierWasExhausted = false;

  for (const tier of TIER_ORDER) {
    const providers = await prisma.nexusProvider.findMany({
      where:   { isActive: true, tier },
      orderBy: { createdAt: 'asc' },
    });

    const ordered = costWeight > 0 ? costOrder(providers, priceOf, costWeight) : providers;

    for (const provider of ordered) {
      const model: RouteModel = { modelString: provider.preferredModel ?? '', modelId: null, tier };
      const route = await tryPickKey(provider, reserveTokens, ownerTeamId, model);
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
): Promise<NexusRoute | null> {
  const costWeight = await getCostWeight();
  const registry   = await getModelRegistry();

  // Model-first candidate list (Phase 6.1): the registry, filtered to this capability
  // and to providers that actually have a pool, ordered tier → priority → cost.
  const priceById = new Map<string, number | null>();
  for (const m of registry) priceById.set(m.id, effectivePrice(m as unknown as Record<string, unknown>));
  const candidates = selectModels(registry as unknown as SelectableModel[], {
    capability,
    activeProviderSlugs: await activeProviderSlugs(),
    priceOf: (m) => priceById.get(m.id) ?? null,
    costWeight,
  });

  // The legacy pool-tier path is used only for chat when no registry model qualifies.
  const allowLegacyChat = capability === 'chat' && candidates.length === 0;

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
      const stickyRoute = await tryStickyKey(stickyKeyId, reserveTokens, scope, pickModel);
      if (stickyRoute) return stickyRoute;
    }
  }

  if (candidates.length > 0) {
    // Pass 1 — the team's own keys, when it has any.
    if (scope.ownerTeamId) {
      const owned = await sweepModels(candidates, reserveTokens, scope.ownerTeamId);
      if (owned) return owned;
      // Hard isolation: exhausting your own keys is a 503, not a silent hand-off to
      // credentials you did not bring.
      if (!scope.fallbackToShared) return null;
    }
    // Pass 2 — the shared pool.
    return sweepModels(candidates, reserveTokens, null);
  }

  // ── Legacy fallback (chat only) ──
  // No registry model is eligible. For chat, fall back to the pre-6.1 pool-tier walk so
  // a deployment whose pools exist but whose registry is empty still serves traffic
  // (boot-seed normally prevents this). Non-chat capabilities have no legacy path.
  if (capability !== 'chat') return null;

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
    const owned = await legacySweepTiers(reserveTokens, scope.ownerTeamId, costWeight, priceOf);
    if (owned) return owned;
    if (!scope.fallbackToShared) return null;
  }
  return legacySweepTiers(reserveTokens, null, costWeight, priceOf);
}

export async function getNextCooldownSeconds(): Promise<number> {
  const cooling = await prisma.nexusKey.findFirst({
    where:   { status: 'cooling', coolingUntil: { not: null } },
    orderBy: { coolingUntil: 'asc' },
  });
  if (!cooling?.coolingUntil) return 60;
  return Math.max(5, Math.ceil((cooling.coolingUntil.getTime() - Date.now()) / 1000));
}

export async function banKey(keyId: string): Promise<void> {
  await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'banned' } });
}

/**
 * Flat, non-escalating cooldown. Used by the admin "cool" action and for 429s
 * (via reportRateLimit). Sets both the Redis breaker gate and the DB display
 * columns so routing and the dashboard agree.
 */
export async function coolKey(keyId: string, seconds = 60): Promise<void> {
  const until = new Date(Date.now() + seconds * 1000);
  await breaker.onRateLimit(keyId, seconds);
  await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'cooling', coolingUntil: until } });
}

// ── Breaker outcome reporters ─────────────────────────────────────────────────
// Each pairs the Redis breaker state (authoritative for routing) with the DB
// status/coolingUntil columns (display only), so the dashboard stays truthful.
// These run on the rare failure/recovery events, never on the happy path's hot
// loop beyond a single onSuccess reset.

/** A healthy response: close the breaker; clear any lingering cooling display. */
export async function reportSuccess(keyId: string, wasProbe: boolean): Promise<void> {
  await breaker.onSuccess(keyId);
  // Only touch the DB when recovering a key that was actually cooling — a normal
  // closed-state success writes nothing.
  if (wasProbe) {
    await prisma.nexusKey.updateMany({
      where: { id: keyId, status: 'cooling' },
      data:  { status: 'active', coolingUntil: null },
    });
  }
}

/** A 429: flat cooldown, no escalation, no strike. */
export async function reportRateLimit(keyId: string, seconds = breaker.RATE_LIMIT_COOLDOWN_SECONDS): Promise<void> {
  await coolKey(keyId, seconds);
}

/** A server-side failure (5xx / timeout / hung stream): strike or escalate. */
export async function reportServerFailure(keyId: string, wasProbe: boolean): Promise<void> {
  const { opened, cooldownSeconds } = await breaker.onServerFailure(keyId, wasProbe);
  if (opened) {
    const until = new Date(Date.now() + cooldownSeconds * 1000);
    await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'cooling', coolingUntil: until } });
    void alertKeyEvent(keyId, 'opened', cooldownSeconds).catch(() => {});
  }
}

/** An auth failure (401/403): ban the key outright once the threshold is hit. */
export async function reportAuthFailure(keyId: string): Promise<void> {
  const { banned } = await breaker.onAuthFailure(keyId);
  if (banned) {
    await banKey(keyId);
    void alertKeyEvent(keyId, 'banned').catch(() => {});
  }
}

// Fire-and-forget operator alert (Phase 6.4) for a key-level failure. The armed check is a
// cheap cached read, so the extra lookup for the provider/masked-key display only runs when
// notifications are actually enabled for this event. Never awaited by the reporters.
async function alertKeyEvent(keyId: string, kind: 'banned' | 'opened', cooldownSeconds = 0): Promise<void> {
  const event = kind === 'banned' ? 'keyBanned' : 'breakerOpened';
  if (!(await notificationsArmed(event))) return;
  const k = await prisma.nexusKey.findUnique({
    where: { id: keyId }, select: { maskedKey: true, provider: { select: { slug: true } } },
  });
  if (!k) return;
  await notify(kind === 'banned'
    ? keyBannedMessage(k.provider.slug, k.maskedKey)
    : breakerOpenedMessage(k.provider.slug, k.maskedKey, cooldownSeconds));
}

/**
 * Fire-and-forget operator alert (Phase 6.4b) for a request-path 503: every key able to
 * serve `capability` is exhausted, so the gateway is refusing that traffic. Called from the
 * `discoverBestPool → null` boundary in both the chat and non-chat handlers, giving one
 * uniform tap. `isolated` distinguishes a hard-isolated BYOK team from the shared pool.
 * Armed check gates it to a cheap cached read; coalescing keeps a persistent outage to one
 * message per window. Never awaited by the caller.
 */
export async function reportTierExhausted(capability: Capability, isolated: boolean): Promise<void> {
  if (!(await notificationsArmed('tierExhausted'))) return;
  await notify(tierExhaustedMessage(capability, isolated));
}

export async function testKey(keyId: string): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  const key = await prisma.nexusKey.findUnique({
    where:   { id: keyId },
    include: { provider: true },
  });
  if (!key) return { success: false, error: 'Key not found' };

  const apiKey  = decrypt(key.encryptedKey);
  const baseUrl = stripTrailingSlash(key.provider.baseUrl ?? providerDefaultUrl(key.provider.provider));
  const start   = Date.now();

  try {
    assertSafeUrl(baseUrl, await getSsrfPolicy());
    const res = await fetch(`${baseUrl}/models`, {
      headers: { [key.provider.authHeader]: `${key.provider.authPrefix ?? 'Bearer'} ${apiKey}` },
      signal:  AbortSignal.timeout(5000),
    });
    return { success: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function validateProviderCredentials(
  provider: string,
  baseUrl: string | null,
  apiKey: string,
  authHeader: string,
  authPrefix: string | null,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const base  = stripTrailingSlash(baseUrl ?? providerDefaultUrl(provider));
  const url   = `${base}/models`;
  const start = Date.now();
  try {
    assertSafeUrl(base, await getSsrfPolicy());
    const res = await fetch(url, {
      headers: { [authHeader]: `${authPrefix ?? 'Bearer'} ${apiKey}` },
      signal:  AbortSignal.timeout(8000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export async function validateModel(
  providerId: string,
  modelName: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const provider = await prisma.nexusProvider.findUnique({
    where:   { id: providerId },
    include: { keys: { take: 1, where: { status: 'active' }, orderBy: { lastUsedAt: 'asc' } } },
  });
  if (!provider)              return { ok: false, latencyMs: 0, error: 'Provider not found' };
  if (!provider.keys.length)  return { ok: false, latencyMs: 0, error: 'No active key for this provider — add a key first' };

  const apiKey  = decrypt(provider.keys[0].encryptedKey);
  const baseUrl = stripTrailingSlash(provider.baseUrl ?? providerDefaultUrl(provider.provider));
  const start   = Date.now();

  try {
    assertSafeUrl(baseUrl, await getSsrfPolicy());
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        [provider.authHeader]: `${provider.authPrefix ?? 'Bearer'} ${apiKey}`,
      },
      body:   JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    if (res.ok) return { ok: true, latencyMs };
    const errText = await res.text().catch(() => '');
    return { ok: false, latencyMs, error: `HTTP ${res.status}: ${errText.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Request failed' };
  }
}

// The upper bound on models returned from a fetch — a defensive cap so a misconfigured path
// pointed at a huge array can't flood the dashboard.
const MAX_FETCHED_MODELS = 500;

/**
 * Fetch a provider's live model list (Phase 7.4b). Calls the pool's `modelFetchUrl` (or the
 * conventional `<baseUrl>/models`) with a key, and reads the ids using the pool's `modelIdPath`.
 * This is how "Fetch Models" stays future-proof: a provider releasing a new model surfaces it here
 * with no code change. `plainKey` lets the add-key form fetch before its key is saved; otherwise an
 * existing active key for the pool is used. SSRF-guarded like every other outbound admin call.
 */
export async function fetchProviderModels(
  providerId: string,
  plainKey?: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const provider = await prisma.nexusProvider.findUnique({
    where:   { id: providerId },
    include: { keys: { where: { status: 'active' }, take: 1, orderBy: { lastUsedAt: 'asc' } } },
  });
  if (!provider) return { ok: false, models: [], error: 'Provider not found' };

  let apiKey = plainKey?.trim();
  if (!apiKey) {
    if (!provider.keys.length) return { ok: false, models: [], error: 'Enter an API key, or add an active key to this pool first' };
    apiKey = decrypt(provider.keys[0].encryptedKey);
  }

  const base = stripTrailingSlash(provider.baseUrl ?? providerDefaultUrl(provider.provider));
  const url  = provider.modelFetchUrl ?? (base ? `${base}/models` : '');
  if (!url) return { ok: false, models: [], error: 'No base URL or model-fetch URL configured for this pool' };

  try {
    assertSafeUrl(url, await getSsrfPolicy());
    const res = await fetch(url, {
      headers: { [provider.authHeader]: `${provider.authPrefix ?? 'Bearer'} ${apiKey}` },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const json   = await res.json().catch(() => null);
    const models = extractModelIds(json, provider.modelIdPath).slice(0, MAX_FETCHED_MODELS);
    if (!models.length) return { ok: false, models: [], error: 'No models found at the configured model-id path' };
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : 'Fetch failed' };
  }
}
