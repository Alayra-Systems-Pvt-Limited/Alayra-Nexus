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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { nexusProvider: { findMany: vi.fn() } },
}));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: prismaMock }));

const { getRoutingConfigForUI } = vi.hoisted(() => ({ getRoutingConfigForUI: vi.fn() }));
vi.mock('./routing.service', () => ({ getRoutingConfigForUI }));

import { getNexusOverview } from './nexusOverview.service';

const NOW = new Date('2026-07-11T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  getRoutingConfigForUI.mockResolvedValue({ costWeight: 0.3 });
});

describe('getNexusOverview', () => {
  it('groups pools by tier in routing order and tallies key health', async () => {
    prismaMock.nexusProvider.findMany.mockResolvedValue([
      {
        id: 'p1', name: 'OpenAI Prod', slug: 'openai-prod', provider: 'openai', tier: 'standard', preferredModel: 'gpt-4o',
        keys: [
          { id: 'k1', maskedKey: 'sk-…1', label: 'A', status: 'active',  coolingUntil: null,                          rpmLimit: 60, ownerTeam: null,               lastUsedAt: null },
          { id: 'k2', maskedKey: 'sk-…2', label: null, status: 'active',  coolingUntil: new Date('2026-07-11T13:00:00Z'), rpmLimit: 60, ownerTeam: null,               lastUsedAt: null }, // cooling (future)
          { id: 'k3', maskedKey: 'sk-…3', label: null, status: 'banned',  coolingUntil: null,                          rpmLimit: 60, ownerTeam: { name: 'Acme' },     lastUsedAt: null },
        ],
      },
      {
        id: 'p2', name: 'Anthropic', slug: 'anthropic', provider: 'anthropic', tier: 'premium', preferredModel: null,
        keys: [
          { id: 'k4', maskedKey: 'sk-…4', label: null, status: 'active', coolingUntil: new Date('2026-07-11T11:00:00Z'), rpmLimit: 60, ownerTeam: null, lastUsedAt: null }, // cooldown passed → usable
        ],
      },
    ]);

    const out = await getNexusOverview(NOW);

    expect(out.routing.costWeight).toBe(0.3);
    expect(out.summary).toEqual({ providers: 2, activeKeys: 2, coolingKeys: 1, bannedKeys: 1, totalKeys: 4 });
    // premium is walked before standard
    expect(out.tiers.map((t) => t.tier)).toEqual(['premium', 'standard']);
    expect(out.tiers[0].providers[0].name).toBe('Anthropic');
    // BYOK owner name is flattened; shared keys report null
    const k3 = out.tiers[1].providers[0].keys.find((k) => k.id === 'k3');
    expect(k3?.ownerTeamName).toBe('Acme');
  });

  it('omits tiers that have no pools', async () => {
    prismaMock.nexusProvider.findMany.mockResolvedValue([
      { id: 'p1', name: 'Fast Pool', slug: 'fast', provider: 'groq', tier: 'fast', preferredModel: null, keys: [] },
    ]);
    const out = await getNexusOverview(NOW);
    expect(out.tiers.map((t) => t.tier)).toEqual(['fast']);
    expect(out.summary.totalKeys).toBe(0);
  });
});
