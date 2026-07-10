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

// ── Model-first selection (Phase 6.1) ─────────────────────────────────────────
// Routing used to walk *pools* by tier and take each pool's single `preferredModel`.
// That put the model on the credential, so one Anthropic key could serve exactly one
// model, and the Models tab that operators actually edit did not drive routing at all.
//
// Selection now walks *models*: the registry is the source of truth for which model
// runs, its tier, and its priority. A pool is reduced to what it always really was —
// a provider's base URL, auth, and keys. This module is the pure ordering step; the
// key/breaker/admission mechanics stay in nexus.service and are unchanged.

import { costOrder } from './routing';

export const CAPABILITIES = ['chat', 'completion', 'embedding', 'image', 'speech', 'transcription'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Tiers, best first. A premium model is preferred over a standard one, and so on — the
 *  same failover order the pool-tier walk used, now expressed at the model level. */
export const TIER_ORDER = ['premium', 'standard', 'fast'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export function tierRank(tier: string): number {
  const i = (TIER_ORDER as readonly string[]).indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i; // unknown tiers sort last
}

/** The registry fields selection needs. Pricing is read via `priceOf`, not here. */
export interface SelectableModel {
  id:           string;
  modelString:  string;
  provider:     string;            // provider slug, e.g. "anthropic" — links to a pool
  tier:         string;
  priority:     number;
  status:       string;            // "active" | "paused" | "retired"
  capabilities: string[];
}

export interface SelectOptions {
  /** Which endpoint is asking. Only models declaring this capability are eligible. */
  capability: Capability;
  /** Provider slugs that currently have at least one active pool. A model whose
   *  provider has no pool cannot be served, so it is excluded before ordering. */
  activeProviderSlugs: Set<string>;
  /** Relative price of a model (input+output per-1k proxy), or null when unpriced. */
  priceOf: (m: SelectableModel) => number | null;
  /** Cost-aware weight in [0,1]. 0 leaves priority order untouched. */
  costWeight: number;
}

/**
 * The ordered list of models to attempt, best first.
 *
 * Order is tier first (premium → standard → fast), then ascending `priority` within a
 * tier, then — only when cost-aware routing is enabled — cheapest first as a
 * tiebreaker *inside* each tier. Cost never crosses a tier boundary, exactly as in the
 * pool-tier router: a cheap fast model never jumps ahead of a premium one.
 *
 * Excluded: paused/retired models, models lacking the capability, and models whose
 * provider has no active pool.
 */
export function selectModels(models: SelectableModel[], opts: SelectOptions): SelectableModel[] {
  const eligible = models.filter((m) =>
    m.status === 'active' &&
    m.capabilities.includes(opts.capability) &&
    opts.activeProviderSlugs.has(m.provider));

  // Primary key: tier. Secondary: priority. Stable, so equal keys keep input order.
  eligible.sort((a, b) => (tierRank(a.tier) - tierRank(b.tier)) || (a.priority - b.priority));

  if (opts.costWeight <= 0) return eligible;

  // Cost is a within-tier tiebreaker only. Reorder each tier group independently so a
  // cheaper model can move up among its peers but never past a better tier.
  const out: SelectableModel[] = [];
  let i = 0;
  while (i < eligible.length) {
    const tier = eligible[i].tier;
    let j = i;
    while (j < eligible.length && eligible[j].tier === tier) j++;
    out.push(...costOrder(eligible.slice(i, j), opts.priceOf, opts.costWeight));
    i = j;
  }
  return out;
}
