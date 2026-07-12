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

// Nexus overview aggregate (Phase 7.3): the single read behind the redesigned Nexus section —
// the provider pools grouped by routing tier, each pool's keys with their live health, plus the
// pool/key totals and the cost-routing weight. One round-trip, read-only. It composes existing
// data; the mutating key actions (ban/unban/cool/test) keep living in keys.routes.

import { prisma } from '../lib/prisma';
import { getRoutingConfigForUI } from './routing.service';
import { parseExtraHeaders } from '../lib/providerHeaders';

// The order routing actually walks pools in (best first). Mirrors TIER_ORDER in nexus.service so
// the Nexus view presents tiers in the same sequence the router tries them.
const TIER_ORDER = ['premium', 'standard', 'fast'] as const;

export interface NexusKeyHealth {
  id:            string;
  maskedKey:     string;
  label:         string | null;
  status:        string;        // active | cooling | banned
  coolingUntil:  string | null;
  rpmLimit:      number;
  tpmLimit:      number;
  maxUsers:      number;
  ownerTeamName: string | null; // null = shared pool
  lastUsedAt:    string | null;
}

export interface NexusPool {
  id:             string;
  name:           string;
  slug:           string;
  provider:       string;
  tier:           string;
  preferredModel: string | null;
  // Pool config the edit form and the model-fetch flow need.
  baseUrl:        string | null;
  modelFetchUrl:  string | null;
  authHeader:     string;
  authPrefix:     string | null;
  modelIdPath:    string;
  // Extra request headers, parsed back to an object for the edit form. {} when none are set.
  extraHeaders:   Record<string, string>;
  keys:           NexusKeyHealth[];
}

export interface NexusOverview {
  summary: { providers: number; activeKeys: number; coolingKeys: number; bannedKeys: number; totalKeys: number };
  routing: { costWeight: number };
  tiers:   { tier: string; providers: NexusPool[] }[];
}

export async function getNexusOverview(now = new Date()): Promise<NexusOverview> {
  const [providers, routing] = await Promise.all([
    prisma.nexusProvider.findMany({
      orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
      include: { keys: { orderBy: { createdAt: 'asc' }, include: { ownerTeam: { select: { name: true } } } } },
    }),
    getRoutingConfigForUI(),
  ]);

  // A key is "usable" iff it is active and not currently cooling — the same test the router
  // applies. Everything else is either cooling (temporarily out) or banned (out until unbanned).
  const usable = (k: { status: string; coolingUntil: Date | null }) =>
    k.status === 'active' && (!k.coolingUntil || k.coolingUntil <= now);

  let activeKeys = 0, coolingKeys = 0, bannedKeys = 0, totalKeys = 0;

  const pools: NexusPool[] = providers.map((p) => ({
    id:             p.id,
    name:           p.name,
    slug:           p.slug,
    provider:       p.provider,
    tier:           p.tier,
    preferredModel: p.preferredModel,
    baseUrl:        p.baseUrl,
    modelFetchUrl:  p.modelFetchUrl,
    authHeader:     p.authHeader,
    authPrefix:     p.authPrefix,
    modelIdPath:    p.modelIdPath,
    extraHeaders:   parseExtraHeaders(p.extraHeaders),
    keys: p.keys.map((k) => {
      totalKeys++;
      if (k.status === 'banned') bannedKeys++;
      else if (usable(k))        activeKeys++;
      else                       coolingKeys++;
      return {
        id:            k.id,
        maskedKey:     k.maskedKey,
        label:         k.label,
        status:        k.status,
        coolingUntil:  k.coolingUntil?.toISOString() ?? null,
        rpmLimit:      k.rpmLimit,
        tpmLimit:      k.tpmLimit,
        maxUsers:      k.maxUsers,
        ownerTeamName: k.ownerTeam?.name ?? null,
        lastUsedAt:    k.lastUsedAt?.toISOString() ?? null,
      };
    }),
  }));

  const tiers = TIER_ORDER
    .map((tier) => ({ tier, providers: pools.filter((p) => p.tier === tier) }))
    .filter((g) => g.providers.length > 0);

  return {
    summary: { providers: providers.length, activeKeys, coolingKeys, bannedKeys, totalKeys },
    routing,
    tiers,
  };
}
