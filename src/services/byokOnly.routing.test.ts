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

// ── byok-only teams: routing and the model listing (P1.1) ─────────────────────────────────────
// The real router and catalogue over the in-memory reference stores and the conformance fixture,
// which holds shared keys, team-a's own OpenAI key, and a team (team-z) that owns nothing. Only the
// KV admission walk and the registry are faked. The property under test: a byok-only team is never
// handed a key with no owner — not by a sweep, not by the legacy walk, not by a sticky pin.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sticky:   null as string | null,
  refuse:   new Set<string>(),
  offered:  [] as string[],
  registry: [] as Record<string, unknown>[],
}));

vi.mock('../lib/selectKey', () => ({
  selectAndReserve: vi.fn(async (candidates: { id: string }[]) => {
    h.offered.push(...candidates.map((c) => c.id));
    const i = candidates.findIndex((c) => !h.refuse.has(c.id));
    return i < 0 ? null : { index: i, gate: 'closed' as const };
  }),
}));
vi.mock('../lib/sticky', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sticky')>()),
  getStickyKeyId: vi.fn(async () => h.sticky),
}));
vi.mock('./routing.service', () => ({ getCostWeight: vi.fn(async () => 0) }));
vi.mock('./model.service', () => ({
  getModelRegistry:    vi.fn(async () => h.registry),
  activeProviderSlugs: vi.fn(async () => new Set((await m.stores.providers.listActive()).map((p) => p.provider))),
}));
vi.mock('./providerCache.service', () => ({
  getActiveProviders: vi.fn(async () => m.stores.providers.listActive()),
}));

import { configureCoreStores } from '../core/stores';
import { configureCoreCipher, resetCoreCipherForTests } from '../core/cipher';
import { createMemoryCoreStores, CONFORMANCE_FIXTURE, type MemoryCoreStores } from '../core/testing';
import { forgetKeyRow } from '../lib/keyRowCache';
import { resolveRequestScope } from './byok.service';
import { discoverBestPool } from './routing/discovery';
import { listServableModels } from './modelCatalog.service';
import type { TeamContext } from '../core/context';

let m: MemoryCoreStores;

const team = (id: string, isolation?: 'byok-only'): TeamContext =>
  ({ id, budgetUsd: null, budgetPeriod: 'monthly', ...(isolation ? { isolation } : {}) });
const SHARED = ['key-shared-1', 'key-shared-2', 'key-anthropic', 'key-cooling-late'];

const model = (id: string, provider: string, tier: string, capabilities = ['chat']) =>
  ({ id, modelString: id, provider, tier, priority: 1, status: 'active', capabilities, displayName: id });

beforeEach(() => {
  m = createMemoryCoreStores(CONFORMANCE_FIXTURE);
  configureCoreStores(() => m.stores);
  resetCoreCipherForTests();
  configureCoreCipher({ decrypt: (_c, ctx) => `plain-${ctx.keyId}` });
  forgetKeyRow();
  h.sticky = null; h.refuse = new Set(); h.offered = [];
  h.registry = [model('claude-x', 'anthropic', 'premium'), model('gpt-x', 'openai', 'standard')];
});

async function route(t: TeamContext, pinned: string | null = null) {
  const scope = await resolveRequestScope(t);
  return discoverBestPool(100, 'session-1', scope, 'chat', null, null, pinned);
}

describe('routing a byok-only team', () => {
  it('with no keys of its own, routes nowhere, and is never offered a shared key', async () => {
    expect(await route(team('team-z', 'byok-only'))).toBeNull();
    expect(h.offered.filter((id) => SHARED.includes(id))).toEqual([]);
  });

  it('a sticky pin to a shared key is refused, with or without own keys', async () => {
    h.sticky = 'key-shared-1';
    expect(await route(team('team-z', 'byok-only'))).toBeNull();
    const r = await route(team('team-a', 'byok-only'));
    expect(r?.keyId).toBe('key-team-a');
    expect(r?.sticky).toBe(false);
    expect(h.offered.filter((id) => SHARED.includes(id))).toEqual([]);
  });

  it('is served by its own key, opened with that key\'s id and owner', async () => {
    const r = await route(team('team-a', 'byok-only'));
    expect(r).toMatchObject({ keyId: 'key-team-a', byok: true, decryptedKey: 'plain-key-team-a', providerSlug: 'openai' });
  });

  it('own keys busy is a refusal, never a hand-off to the shared pool', async () => {
    h.refuse.add('key-team-a');
    expect(await route(team('team-a', 'byok-only'))).toBeNull();
    expect(h.offered.filter((id) => SHARED.includes(id))).toEqual([]);
  });

  it('the legacy pool walk (no registry model) stays inside the team too', async () => {
    h.registry = [];
    expect(await route(team('team-z', 'byok-only'))).toBeNull();
    expect(h.offered.filter((id) => SHARED.includes(id))).toEqual([]);
  });

  it('needs no key count to resolve its scope', async () => {
    const countOwnedUsable = vi.spyOn(m.stores.keys, 'countOwnedUsable');
    expect(await resolveRequestScope(team('team-a', 'byok-only'))).toMatchObject({ ownerTeamId: 'team-a', byokOnly: true });
    expect(countOwnedUsable).not.toHaveBeenCalled();
  });
});

describe('every other caller routes exactly as before', () => {
  it('a team with no keys and no isolation uses the shared pool', async () => {
    const r = await route(team('team-z'));
    expect(SHARED).toContain(r?.keyId);
    expect(r?.byok).toBe(false);
  });

  it('a key-owning team falls back to the shared pool when its own key is busy', async () => {
    h.refuse.add('key-team-a');
    const r = await route(team('team-a'));
    expect(SHARED).toContain(r?.keyId);
  });

  it('the master key (no team) uses the shared pool', async () => {
    const r = await discoverBestPool(100, null, await resolveRequestScope(null), 'chat');
    expect(SHARED).toContain(r?.keyId);
  });
});

describe('GET /v1/models for a byok-only team', () => {
  const ids = async (t: TeamContext | null) =>
    (await listServableModels(await resolveRequestScope(t))).map((e) => e.id);

  it('with no keys lists only the auto entry, which then answers "add a key"', async () => {
    expect(await ids(team('team-z', 'byok-only'))).toEqual(['alayra-nexus-1']);
  });

  it('lists only models of providers it holds a usable key for', async () => {
    // team-a: an active OpenAI key; its Anthropic key is banned and its Groq pool is switched off.
    expect(await ids(team('team-a', 'byok-only'))).toEqual(['alayra-nexus-1', 'gpt-x']);
  });

  it('on a legacy-path gateway (no chat model registered), lists only its own providers\' pools', async () => {
    h.registry = [];
    expect(await ids(team('team-a', 'byok-only'))).toEqual(['alayra-nexus-1']);   // claude-x is Anthropic's pool
    expect(await ids(team('team-z'))).toEqual(['alayra-nexus-1', 'claude-x']);    // unchanged for others
  });

  it('a team with no isolation still sees every servable model', async () => {
    expect(await ids(team('team-z'))).toEqual(['alayra-nexus-1', 'claude-x', 'gpt-x']);
  });
});
