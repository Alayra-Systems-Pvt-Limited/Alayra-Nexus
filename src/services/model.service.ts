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

import { redis }                  from '../lib/redis';
import { prisma }                 from '../lib/prisma';
import { getSetting, setSetting } from './settings.service';
import { REGISTRY_CACHE_KEY }    from '../lib/registryCacheKey';
import { getActiveProviders }    from './providerCache.service';
import { TtlMemo }               from '../lib/ttlMemo';
import { CAPABILITIES, type Capability } from '../lib/modelSelect';

// The registry lives as a JSON blob in AppSettings, not a table, so its shape is not
// enforced by a schema — this interface is the contract, and `normalizeModel` makes
// every stored entry conform to it on read. Fields match what the dashboard writes
// (per-1M pricing, tier, priority); the older per-1k pricing is still tolerated by the
// cost helpers for entries written by early versions.
export interface AiModel {
  id:              string;
  displayName:     string;
  provider:        string;   // provider slug: anthropic | openai | google | groq | openrouter | custom
  modelString:     string;   // the real id sent upstream
  tier:            string;   // premium | standard | fast — drives routing order (Phase 6.1)
  status:          string;   // active | paused | retired
  priority:        number;   // lower is tried first within a tier
  // Capabilities (Phase 6.1): which endpoints this model may serve. Every model gets
  // at least `chat`. This is the field new endpoints (Anthropic, embeddings, images,
  // audio) filter on.
  capabilities:    Capability[];
  // Feature flags, distinct from capabilities: a chat model may or may not see images
  // or call tools. Kept for display and future request validation.
  hasVision:       boolean;
  hasFIM:          boolean;
  hasToolCalling:  boolean;
  inputCostPer1M:  number;
  outputCostPer1M: number;
  // Per-modality price (Phase 6.3b–6.3d). Some models are not billed per token. USD per
  // image (0 = unpriced) for image models; USD per 1,000,000 characters for speech
  // models, matching how TTS providers publish their price; USD per transcription for
  // speech-to-text (a flat per-file price — per-second billing would need the audio's
  // duration, which providers don't return unless the response format is changed).
  imagePrice:            number;
  speechPricePer1MChars: number;
  transcriptionPrice:    number;
  // Realtime/omni audio models bill audio as tokens, separately per direction (Phase 7.4c) —
  // distinct from classic TTS (per input character) and STT (per file). 0 when not an audio model.
  audioInputPer1M:       number;
  audioOutputPer1M:      number;
  // Where the prices above came from. A price of 0 is ambiguous on its own — OpenRouter's
  // `:free` models really do cost nothing, while a model nobody has priced also reads 0 — and
  // that ambiguity is not cosmetic: cost-aware routing treated "unknown" as "free" and sent
  // traffic to it FIRST, and cost analytics reported $0 for it with no indication anything was
  // missing. This field is what separates the two, so `unset` can be ranked and reported
  // honestly. Read by effectivePrice() in lib/routing.ts, and by the dashboard's model rows,
  // model editor and Analytics banner.
  pricingSource:         PricingSource;
  contextWindow:   number;
  maxTokens:       number;
}

/**
 * Provenance of a model's prices.
 *   unset      — nobody has ever priced this model. NOT the same as free.
 *   harvested  — read from the provider's own /models response (OpenRouter, Groq publish it).
 *   catalog    — filled from the bundled pricing catalog, indicative until the operator confirms.
 *   manual     — entered or confirmed by the operator. Includes a deliberate 0.
 */
export const PRICING_SOURCES = ['unset', 'harvested', 'catalog', 'manual'] as const;
export type PricingSource = (typeof PRICING_SOURCES)[number];

/** Every per-unit price on a model. Any one of them being non-zero means somebody priced it. */
const PRICE_FIELDS = [
  'inputCostPer1M', 'outputCostPer1M', 'imagePrice', 'speechPricePer1MChars',
  'transcriptionPrice', 'audioInputPer1M', 'audioOutputPer1M',
] as const;

export class ModelNotFoundError extends Error {
  constructor(id: string) { super(`Model not found: ${id}`); this.name = 'ModelNotFoundError'; }
}

// The registry starts empty and is populated from the operator's pools on first boot
// (see reconcilePoolsToRegistry). Shipping phantom default models would route requests
// to providers the operator never configured.
const DEFAULT_REGISTRY: AiModel[] = [];

const TIER_DEFAULT_PRIORITY: Record<string, number> = { premium: 1, standard: 2, fast: 3 };

/**
 * Coerce one stored entry into a well-formed AiModel. The registry is schemaless JSON,
 * so entries written by older versions can be missing `capabilities`, `tier`, or the
 * feature flags. Every model ends up with at least the `chat` capability; a legacy FIM
 * flag also grants `completion`, so autocomplete tools keep working after the upgrade.
 */
export function normalizeModel(raw: Record<string, unknown>): AiModel {
  const caps = new Set<Capability>();
  if (Array.isArray(raw.capabilities)) {
    for (const c of raw.capabilities) if ((CAPABILITIES as readonly string[]).includes(c as string)) caps.add(c as Capability);
  }
  if (caps.size === 0) caps.add('chat');          // every model can at least chat
  if (raw.hasFIM === true) caps.add('completion'); // legacy FIM flag → completion endpoint

  const tier = typeof raw.tier === 'string' && raw.tier ? raw.tier : 'standard';
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  return {
    id:              typeof raw.id === 'string' && raw.id ? raw.id : (raw.modelString as string) ?? '',
    displayName:     typeof raw.displayName === 'string' ? raw.displayName : '',
    provider:        typeof raw.provider === 'string' ? raw.provider : 'custom',
    modelString:     typeof raw.modelString === 'string' ? raw.modelString : '',
    tier,
    status:          typeof raw.status === 'string' ? raw.status : 'active',
    priority:        num(raw.priority, TIER_DEFAULT_PRIORITY[tier] ?? 2),
    capabilities:    [...caps],
    hasVision:       raw.hasVision === true || raw.supportsVision === true,
    hasFIM:          raw.hasFIM === true,
    hasToolCalling:  raw.hasToolCalling === true || raw.supportsToolCalling === true,
    inputCostPer1M:  num(raw.inputCostPer1M ?? (num(raw.inputPricePer1k) * 1000)),
    outputCostPer1M: num(raw.outputCostPer1M ?? (num(raw.outputPricePer1k) * 1000)),
    imagePrice:            num(raw.imagePrice),
    speechPricePer1MChars: num(raw.speechPricePer1MChars),
    transcriptionPrice:    num(raw.transcriptionPrice),
    audioInputPer1M:       num(raw.audioInputPer1M),
    audioOutputPer1M:      num(raw.audioOutputPer1M),
    pricingSource:   inferPricingSource(raw, num),
    contextWindow:   num(raw.contextWindow),
    maxTokens:       num(raw.maxTokens),
  };
}

/**
 * Provenance for an entry that predates the field. Registries written before this existed carry
 * prices with no record of where they came from, and guessing `unset` for all of them would be a
 * regression: a model the operator priced by hand months ago would start warning and, worse, drop
 * to last under cost routing. So a stored non-zero price is taken as evidence someone set it —
 * `manual` — and only an entry with no price anywhere is called `unset`.
 *
 * The one entry this labels imprecisely is a legacy model deliberately priced at 0. It becomes
 * `unset` rather than `manual`, because a 0 with no provenance is genuinely indistinguishable from
 * never-priced. That errs toward warning about a free model rather than staying silent about an
 * unpriced one — the safe direction, and one click on the row clears it for good.
 */
function inferPricingSource(raw: Record<string, unknown>, num: (v: unknown, d?: number) => number): PricingSource {
  const stated = raw.pricingSource;
  if (typeof stated === 'string' && (PRICING_SOURCES as readonly string[]).includes(stated)) {
    return stated as PricingSource;
  }
  const priced = PRICE_FIELDS.some((f) => num(raw[f]) > 0)
    // The pre-per-1M format, still tolerated by the cost helpers.
    || num(raw.inputPricePer1k) > 0 || num(raw.outputPricePer1k) > 0;
  return priced ? 'manual' : 'unset';
}

/**
 * A few seconds in front of the Redis copy. Measured with `npm run bench:store-ops`, this key
 * was fetched TWICE per request — free against the in-process map standalone mode uses, two
 * network round trips against a real Redis, on a registry an operator edits from a dashboard.
 * See lib/ttlMemo.ts for what the window costs.
 */
const registryMemo = new TtlMemo<AiModel[]>(5_000, 'REGISTRY_MEMO_TTL_MS');

/** Drop the in-process registry memo. Backs `POST /admin/cache/flush`, which clears the shared
 * copy directly and must clear this one too or the button appears to do nothing for a few
 * seconds. */
export function clearRegistryMemo(): void { registryMemo.forget(); }

export async function getModelRegistry(): Promise<AiModel[]> {
  const local = registryMemo.get(REGISTRY_CACHE_KEY);
  if (local !== undefined) return local;

  const cached = await redis.get(REGISTRY_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        // Normalized here too, not just on the database path. The cached copy is whatever some
        // process serialized earlier — including a process running the PREVIOUS release, which
        // knew nothing about fields added since. Returning it raw silently breaks the invariant
        // every caller relies on ("a registry model has every field"): after this upgrade, a
        // pre-upgrade cache entry has no `pricingSource`, so unpriced models would go on being
        // treated as free by cost routing until the key expired. The 60s TTL bounds that to a
        // minute, but a minute of wrong routing is still wrong, and the next field added would
        // reopen the same hole. Normalizing costs one pass over a few dozen objects, at most
        // once per memo window.
        const models = parsed.map((m) => normalizeModel(m as Record<string, unknown>));
        registryMemo.set(REGISTRY_CACHE_KEY, models);
        return models;
      }
    } catch { /* fall through */ }
  }
  const raw = await getSetting('AI_MODEL_REGISTRY');
  let stored: unknown[] = DEFAULT_REGISTRY;
  if (raw && raw !== '[]') { try { const p = JSON.parse(raw); if (Array.isArray(p)) stored = p; } catch { /* use defaults */ } }
  const models = stored.map((m) => normalizeModel(m as Record<string, unknown>));
  await redis.set(REGISTRY_CACHE_KEY, JSON.stringify(models), 'EX', 60);
  registryMemo.set(REGISTRY_CACHE_KEY, models);
  return models;
}

/**
 * Provider slugs that currently have at least one active pool.
 *
 * Served from the shared provider cache rather than its own query: this runs on every routed
 * request, and the answer changes only when an operator edits a pool. See providerCache.service.
 */
export async function activeProviderSlugs(): Promise<Set<string>> {
  return new Set((await getActiveProviders()).map((p) => p.provider));
}

/**
 * One-time transition safety net (Phase 6.1). Before this phase a pool carried its own
 * `preferredModel` and routing used it directly. So that upgrading changes nothing, any
 * active pool whose `preferredModel` is not yet represented in the registry gets a
 * seeded entry — same model string, same tier, `chat` capability — which makes routing
 * behave exactly as before while surfacing the model in the Models tab. Idempotent, and
 * a no-op once the operator manages models themselves.
 */
export async function reconcilePoolsToRegistry(): Promise<number> {
  const [registry, pools] = await Promise.all([
    getModelRegistry(),
    prisma.nexusProvider.findMany({
      where:  { isActive: true, preferredModel: { not: null } },
      select: { provider: true, preferredModel: true, tier: true, name: true },
    }),
  ]);

  const have = new Set(registry.map((m) => `${m.provider}::${m.modelString}`));
  const additions: AiModel[] = [];
  for (const p of pools) {
    const key = `${p.provider}::${p.preferredModel}`;
    if (!p.preferredModel || have.has(key)) continue;
    have.add(key);
    additions.push(normalizeModel({
      id:           `seed-${p.provider}-${p.preferredModel}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 80),
      displayName:  p.preferredModel,
      provider:     p.provider,
      modelString:  p.preferredModel,
      tier:         p.tier,
      status:       'active',
      capabilities: ['chat'],
    }));
  }
  if (additions.length === 0) return 0;
  await updateModelRegistry([...registry, ...additions]);
  return additions.length;
}

export async function updateModelRegistry(models: AiModel[]): Promise<void> {
  await setSetting('AI_MODEL_REGISTRY', JSON.stringify(models));
  await redis.del(REGISTRY_CACHE_KEY);
  registryMemo.forget();
}

/**
 * Remove one model by id. Deleting used to go through the whole-registry PUT, which recorded the
 * action in the audit trail as `models.update` — a delete that reads as an edit. Returns false when
 * nothing matched, so the route can 404 honestly.
 */
export async function removeModelById(id: string): Promise<boolean> {
  const registry = await getModelRegistry();
  const kept = registry.filter((m) => m.id !== id);
  if (kept.length === registry.length) return false;
  await updateModelRegistry(kept);
  return true;
}

/**
 * Drop every model belonging to a provider slug, and report how many went. Called when the last
 * pool for that provider is deleted: the registry is keyed by provider slug with no foreign key, so
 * without this the models outlive their pool and reappear the moment a pool of the same provider is
 * created again.
 */
export async function removeModelsForProvider(provider: string): Promise<number> {
  const registry = await getModelRegistry();
  const kept = registry.filter((m) => m.provider !== provider);
  const removed = registry.length - kept.length;
  if (removed > 0) await updateModelRegistry(kept);
  return removed;
}

export async function getModelById(id: string): Promise<AiModel> {
  const registry = await getModelRegistry();
  const model = registry.find(m => m.id === id || m.modelString === id);
  if (!model) throw new ModelNotFoundError(id);
  return model;
}

