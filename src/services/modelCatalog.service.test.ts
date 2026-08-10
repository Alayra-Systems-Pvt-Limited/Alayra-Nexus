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

/**
 * The model catalogue.
 *
 * `GET /v1/models` had no test of any kind — it returned a hardcoded literal, so there was
 * nothing to assert beyond the literal itself. The claims that matter now are the ones a
 * hardcoded list could never break:
 *
 *   - the listing shows the operator's models, and hides the ones routing would refuse;
 *   - a pin resolves to a model routing can actually reach, by id OR by model string;
 *   - a model this gateway cannot serve is a 400, never a quiet substitution.
 *
 * The registry, the pool cache and the key table are faked; each is exercised against the
 * real database elsewhere. What is under test here is the filtering, which is the part that
 * has to agree with `selectModels` or the listing starts advertising 503s.
 */

const h = vi.hoisted(() => ({
  registry:  [] as Record<string, unknown>[],
  slugs:     new Set<string>(),
  providers: [] as Record<string, unknown>[],
  ownedKeys: [] as Record<string, unknown>[],
}));

vi.mock('./model.service', async (importOriginal) => ({
  // normalizeModel is real — the fixtures below are written the way an operator's registry
  // is stored, and normalizing them here is what keeps the test honest about defaults.
  ...(await importOriginal<typeof import('./model.service')>()),
  getModelRegistry:    vi.fn(async () => h.registry),
  activeProviderSlugs: vi.fn(async () => h.slugs),
}));
vi.mock('./providerCache.service', () => ({ getActiveProviders: vi.fn(async () => h.providers) }));
vi.mock('../lib/prisma', () => ({
  prisma: {
    nexusKey: {
      findMany: vi.fn(async () => h.ownedKeys),
      count:    vi.fn(async () => h.ownedKeys.length),
    },
  },
}));

import { listServableModels, resolveRequestedModel, noCapacityMessage, isAutoModel, AUTO_MODEL_ID } from './modelCatalog.service';

/** A registry entry with the fields selection reads; the rest default as normalizeModel would. */
function model(over: Record<string, unknown> = {}) {
  return {
    id: 'gpt4o', displayName: 'GPT-4o', provider: 'openai', modelString: 'gpt-4o',
    tier: 'premium', status: 'active', priority: 1, capabilities: ['chat'],
    contextWindow: 128_000, maxTokens: 4096, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.registry  = [];
  h.slugs     = new Set();
  h.providers = [];
  h.ownedKeys = [];
});

describe('listServableModels', () => {
  it('always offers the auto-route entry first, even with nothing configured', async () => {
    const list = await listServableModels();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: AUTO_MODEL_ID, auto: true });
  });

  it('lists the operator\'s models after the auto entry', async () => {
    h.registry = [model(), model({ id: 'sonnet', provider: 'anthropic', modelString: 'claude-sonnet-4-5' })];
    h.slugs    = new Set(['openai', 'anthropic']);

    const list = await listServableModels();
    expect(list.map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'gpt4o', 'sonnet']);
    expect(list[1]).toMatchObject({ displayName: 'GPT-4o', provider: 'openai', contextWindow: 128_000 });
  });

  it('hides a model the operator paused', async () => {
    h.registry = [model(), model({ id: 'old', status: 'retired' }), model({ id: 'off', status: 'paused' })];
    h.slugs    = new Set(['openai']);

    expect((await listServableModels()).map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'gpt4o']);
  });

  it('hides a model whose provider has no live pool', async () => {
    // The pool was deleted or deactivated; the registry entry outlives it. Routing would
    // skip this model, so advertising it would promise a 503.
    h.registry = [model(), model({ id: 'orphan', provider: 'groq' })];
    h.slugs    = new Set(['openai']);

    expect((await listServableModels()).map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'gpt4o']);
  });

  it('falls back to the pools\' own preferred models when the registry is empty', async () => {
    // Mirrors the legacy chat path in discoverBestPool: a gateway in this state serves
    // traffic, so a listing that showed nothing would contradict a working request.
    h.providers = [
      { provider: 'openai',    preferredModel: 'gpt-4o-mini' },
      { provider: 'anthropic', preferredModel: 'claude-3-5-haiku' },
      { provider: 'groq',      preferredModel: null },
    ];

    expect((await listServableModels()).map((m) => m.id))
      .toEqual([AUTO_MODEL_ID, 'gpt-4o-mini', 'claude-3-5-haiku']);
  });

  it('still shows the pools\' chat models when the registry holds no chat model', async () => {
    // The legacy walk triggers on "no CHAT-capable model qualifies", not "the registry is
    // empty". A gateway like this one serves chat from its pool, so the listing has to
    // agree — an embedding entry in the registry must not hide that.
    h.registry  = [model({ id: 'embed', capabilities: ['embedding'] })];
    h.slugs     = new Set(['openai']);
    h.providers = [{ provider: 'openai', preferredModel: 'gpt-4o-mini' }];

    expect((await listServableModels()).map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'embed', 'gpt-4o-mini']);
  });

  it('narrows a hard-isolated team to the providers it brought keys for', async () => {
    h.registry  = [model(), model({ id: 'sonnet', provider: 'anthropic' })];
    h.slugs     = new Set(['openai', 'anthropic']);
    h.ownedKeys = [{ provider: { provider: 'anthropic', isActive: true } }];

    const list = await listServableModels({ ownerTeamId: 't1', fallbackToShared: false, namespace: 'team:t1' });
    expect(list.map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'sonnet']);
  });

  it('does NOT narrow a team that may fall back to the shared pool', async () => {
    // Its own keys are one route among several; hiding pooled models would understate
    // what will actually serve it.
    h.registry  = [model(), model({ id: 'sonnet', provider: 'anthropic' })];
    h.slugs     = new Set(['openai', 'anthropic']);
    h.ownedKeys = [{ provider: { provider: 'anthropic', isActive: true } }];

    const list = await listServableModels({ ownerTeamId: 't1', fallbackToShared: true, namespace: 'team:t1' });
    expect(list.map((m) => m.id)).toEqual([AUTO_MODEL_ID, 'gpt4o', 'sonnet']);
  });
});

describe('isAutoModel', () => {
  it('accepts every alias, in any case, and rejects a real model id', () => {
    for (const alias of ['alayra-nexus-1', 'kinetic-nexus-1', 'nexus', 'auto', 'default', 'AUTO', ' Nexus ']) {
      expect(isAutoModel(alias)).toBe(true);
    }
    expect(isAutoModel('gpt-4o')).toBe(false);
  });

  // The dashboard's Quick Start has always told operators to send "auto"; the gateway
  // answered that with a 400, so the first request a new operator copy-pasted failed.
  it('accepts the value the dashboard tells operators to send', () => {
    expect(isAutoModel('auto')).toBe(true);
  });
});

describe('resolveRequestedModel', () => {
  beforeEach(() => {
    h.registry = [model(), model({ id: 'embed', provider: 'openai', modelString: 'text-embedding-3-large', capabilities: ['embedding'] })];
    h.slugs    = new Set(['openai']);
  });

  it('treats an absent or alias model as auto-route', async () => {
    for (const raw of [undefined, '', '  ', 'auto', 'alayra-nexus-1', 'nexus']) {
      expect(await resolveRequestedModel(raw, 'chat')).toEqual({ kind: 'auto' });
    }
  });

  it('pins by registry id', async () => {
    const res = await resolveRequestedModel('gpt4o', 'chat');
    expect(res).toMatchObject({ kind: 'pinned', model: { id: 'gpt4o' } });
  });

  it('pins by the provider\'s own model string, case-insensitively', async () => {
    // A client configured with "gpt-4o" must reach the entry however the operator named it.
    const res = await resolveRequestedModel('GPT-4O', 'chat');
    expect(res).toMatchObject({ kind: 'pinned', model: { id: 'gpt4o' } });
  });

  it('will not pin a model that cannot serve the endpoint being called', async () => {
    // The embedding model exists and is healthy — it just cannot answer a chat request.
    const res = await resolveRequestedModel('embed', 'chat');
    expect(res.kind).toBe('unknown');
  });

  it('rejects an unknown model instead of routing somewhere else', async () => {
    const res = await resolveRequestedModel('llama-99b', 'chat');
    expect(res).toMatchObject({ kind: 'unknown', requested: 'llama-99b' });
    // The alternatives are named, so the caller can fix it without reading the docs.
    expect((res as { available: string[] }).available).toEqual([AUTO_MODEL_ID, 'gpt4o']);
  });

  it('rejects a paused model rather than silently auto-routing past it', async () => {
    h.registry = [model({ status: 'paused' })];
    expect((await resolveRequestedModel('gpt4o', 'chat')).kind).toBe('unknown');
  });

  it('pins a pool\'s preferred model on a legacy (empty-registry) deployment', async () => {
    h.registry  = [];
    h.slugs     = new Set();
    h.providers = [{ provider: 'openai', preferredModel: 'gpt-4o-mini' }];

    expect(await resolveRequestedModel('gpt-4o-mini', 'chat'))
      .toMatchObject({ kind: 'pinned', model: { id: 'gpt-4o-mini', modelString: 'gpt-4o-mini' } });
  });
});

describe('noCapacityMessage', () => {
  // Every routing failure used to read "All API keys are currently rate-limited", including
  // on a gateway with nothing configured — advice that sent the operator to wait for a
  // cooldown that was never going to come.
  it('says nothing is configured when there are no pools', async () => {
    const msg = await noCapacityMessage({ isolated: false, pinnedModelId: null, retryAfter: 60 });
    expect(msg).toContain('No provider pools are configured');
    expect(msg).not.toContain('rate-limited');
  });

  it('says there are no keys when pools exist but hold none', async () => {
    h.providers = [{ provider: 'openai', preferredModel: 'gpt-4o' }];
    h.ownedKeys = [];
    const msg = await noCapacityMessage({ isolated: false, pinnedModelId: null, retryAfter: 60 });
    expect(msg).toContain('No usable provider API keys');
  });

  it('names the pinned model, and offers auto-route as the way out', async () => {
    h.providers = [{ provider: 'openai', preferredModel: 'gpt-4o' }];
    h.ownedKeys = [{ provider: { provider: 'openai', isActive: true } }];
    const msg = await noCapacityMessage({ isolated: false, pinnedModelId: 'gpt4o', retryAfter: 30 });
    expect(msg).toContain('gpt4o');
    expect(msg).toContain(AUTO_MODEL_ID);
  });

  it('keeps the rate-limit message for a configured gateway that is genuinely saturated', async () => {
    h.providers = [{ provider: 'openai', preferredModel: 'gpt-4o' }];
    h.ownedKeys = [{ provider: { provider: 'openai', isActive: true } }];
    const msg = await noCapacityMessage({ isolated: false, pinnedModelId: null, retryAfter: 30 });
    expect(msg).toContain('rate-limited');
  });
});
