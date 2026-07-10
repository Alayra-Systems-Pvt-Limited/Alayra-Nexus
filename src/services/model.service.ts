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
  contextWindow:   number;
  maxTokens:       number;
}

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
    contextWindow:   num(raw.contextWindow),
    maxTokens:       num(raw.maxTokens),
  };
}

export async function getModelRegistry(): Promise<AiModel[]> {
  const cached = await redis.get(REGISTRY_CACHE_KEY);
  if (cached) { try { return JSON.parse(cached) as AiModel[]; } catch { /* fall through */ } }
  const raw = await getSetting('AI_MODEL_REGISTRY');
  let stored: unknown[] = DEFAULT_REGISTRY;
  if (raw && raw !== '[]') { try { const p = JSON.parse(raw); if (Array.isArray(p)) stored = p; } catch { /* use defaults */ } }
  const models = stored.map((m) => normalizeModel(m as Record<string, unknown>));
  await redis.set(REGISTRY_CACHE_KEY, JSON.stringify(models), 'EX', 60);
  return models;
}

/** Provider slugs that currently have at least one active pool. */
export async function activeProviderSlugs(): Promise<Set<string>> {
  const rows = await prisma.nexusProvider.findMany({ where: { isActive: true }, select: { provider: true } });
  return new Set(rows.map((r) => r.provider));
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
}

export async function getModelById(id: string): Promise<AiModel> {
  const registry = await getModelRegistry();
  const model = registry.find(m => m.id === id || m.modelString === id);
  if (!model) throw new ModelNotFoundError(id);
  return model;
}

