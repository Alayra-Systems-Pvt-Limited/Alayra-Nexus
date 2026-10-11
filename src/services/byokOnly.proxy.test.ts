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

// ── byok-only teams: what the caller is told (P1.1) ───────────────────────────────────────────
// Chat and the non-chat endpoints, through the real scope, catalogue and router over the in-memory
// stores. A byok-only team with no key that could serve a request gets a 403 `byok_key_required`
// in OpenAI's error shape — never a 503 "retry later", never an operator alert, never a provider
// call. One whose own keys are merely busy still gets the 503.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ refuse: new Set<string>(), registry: [] as Record<string, unknown>[] }));

vi.mock('../lib/selectKey', () => ({
  selectAndReserve: vi.fn(async (candidates: { id: string }[]) => {
    const i = candidates.findIndex((c) => !h.refuse.has(c.id));
    return i < 0 ? null : { index: i, gate: 'closed' as const };
  }),
}));
vi.mock('../lib/sticky', async (o) => ({ ...(await o<typeof import('../lib/sticky')>()), getStickyKeyId: vi.fn(async () => null) }));
vi.mock('../lib/safeFetch', () => ({ safeFetch: vi.fn(async () => { throw new Error('no provider call expected'); }) }));
vi.mock('./nexus.service', async (o) => ({
  ...(await o<typeof import('./nexus.service')>()),
  getNextCooldownSeconds: vi.fn(async () => 42),
  reportTierExhausted:    vi.fn(async () => {}),
}));
vi.mock('./token.service', () => ({ recordTokenUsage: vi.fn(async () => {}), recordOutcome: vi.fn(async () => {}) }));
vi.mock('./routing.service', () => ({ getCostWeight: vi.fn(async () => 0) }));
vi.mock('./cache.service', () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 0 })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./model.service', () => ({
  getModelRegistry:    vi.fn(async () => h.registry),
  activeProviderSlugs: vi.fn(async () => new Set((await m.stores.providers.listActive()).map((p) => p.provider))),
}));
vi.mock('./providerCache.service', () => ({ getActiveProviders: vi.fn(async () => m.stores.providers.listActive()) }));

import type { FastifyReply } from 'fastify';
import { configureCoreStores } from '../core/stores';
import { configureCoreCipher, resetCoreCipherForTests } from '../core/cipher';
import { createMemoryCoreStores, CONFORMANCE_FIXTURE, type MemoryCoreStores } from '../core/testing';
import { forgetKeyRow } from '../lib/keyRowCache';
import { safeFetch } from '../lib/safeFetch';
import { handleProxy } from './completionsProxy.service';
import { dispatchProxy } from './proxyDispatch.service';
import { reportTierExhausted } from './nexus.service';
import { recordOutcome } from './token.service';
import type { TeamContext } from '../core/context';

let m: MemoryCoreStores;

const team = (id: string, isolation?: 'byok-only'): TeamContext =>
  ({ id, budgetUsd: null, budgetPeriod: 'monthly', ...(isolation ? { isolation } : {}) });
const model = (id: string, provider: string, capabilities: string[]) =>
  ({ id, modelString: id, provider, tier: 'standard', priority: 1, status: 'active', capabilities, displayName: id });

function fakeReply() {
  const state = { status: 0, sent: undefined as unknown };
  const reply = {
    code(c: number) { state.status = c; return reply; },
    header() { return reply; },
    send(b: unknown) { state.sent = b; return reply; },
    hijack() {}, raw: { writeHead() {}, write() {}, end() {} },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const messages = [{ role: 'user', content: 'hello' }];
async function chat(t: TeamContext, modelId = 'auto') {
  const { reply, state } = fakeReply();
  await handleProxy({ model: modelId, messages }, reply, 'tk-1', {}, t);
  return state;
}
async function embed(t: TeamContext, modelId = 'auto') {
  const { reply, state } = fakeReply();
  await dispatchProxy({ model: modelId, input: 'hi' }, reply,
    { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 10, team: t, teamKeyId: 'tk-1' });
  return state;
}
const code = (s: { sent: unknown }) => (s.sent as { error?: { code?: string } }).error?.code;
const message = (s: { sent: unknown }) => (s.sent as { error: { message: string } }).error.message;

beforeEach(() => {
  vi.clearAllMocks();
  m = createMemoryCoreStores(CONFORMANCE_FIXTURE);
  configureCoreStores(() => m.stores);
  resetCoreCipherForTests();
  configureCoreCipher({ decrypt: (_c, ctx) => `plain-${ctx.keyId}` });
  forgetKeyRow();
  h.refuse = new Set();
  h.registry = [
    model('gpt-x', 'openai', ['chat']), model('claude-x', 'anthropic', ['chat']),
    model('embed-anthropic', 'anthropic', ['embedding']),
  ];
});

describe('a byok-only team with no key of its own', () => {
  it('chat: 403 byok_key_required in the OpenAI error shape, with no provider call and no operator alert', async () => {
    const s = await chat(team('team-z', 'byok-only'));
    expect(s.status).toBe(403);
    expect(s.sent).toEqual({ error: {
      message: expect.stringContaining('Add an API key for one of "openai", "anthropic"'),
      type: 'invalid_request_error', code: 'byok_key_required', param: null,
    } });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(reportTierExhausted).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'client_error', teamId: 'team-z' }));
  });

  it('embeddings (every dispatchProxy endpoint): the same 403', async () => {
    const s = await embed(team('team-z', 'byok-only'));
    expect(s.status).toBe(403);
    expect(code(s)).toBe('byok_key_required');
    expect(safeFetch).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'client_error', teamId: 'team-z' }));
  });
});

describe('a byok-only team with keys for some providers', () => {
  it('pinning a model of a provider it has no key for names that provider (chat and non-chat)', async () => {
    // team-a's Anthropic key is banned: banned is not usable.
    const s = await chat(team('team-a', 'byok-only'), 'claude-x');
    expect(s.status).toBe(403);
    expect(message(s)).toContain('Add an API key for "anthropic"');
    const e = await embed(team('team-a', 'byok-only'), 'embed-anthropic');
    expect(e.status).toBe(403);
    expect(message(e)).toContain('"anthropic"');
  });

  it('auto-routing a capability only other providers serve is a 403 naming them', async () => {
    const s = await embed(team('team-a', 'byok-only'));
    expect(s.status).toBe(403);
    expect(message(s)).toContain('"anthropic"');
  });

  it('a model nobody serves stays the ordinary 400', async () => {
    const s = await chat(team('team-a', 'byok-only'), 'no-such-model');
    expect(s.status).toBe(400);
    expect(code(s)).toBeUndefined();
  });

  it('its own keys merely busy is the normal 503 with Retry-After, not a 403', async () => {
    h.refuse.add('key-team-a');
    const s = await chat(team('team-a', 'byok-only'));
    expect(s.status).toBe(503);
    expect((s.sent as { retryAfter: number }).retryAfter).toBe(42);
  });
});

describe('teams without byok-only are answered exactly as before', () => {
  it('a team with no keys is served from the shared pool (the provider call is reached)', async () => {
    const s = await chat(team('team-z'));
    // The stubbed provider call throws, so reaching it ends in a 504 — the point is that it was reached.
    expect(safeFetch).toHaveBeenCalled();
    expect(s.status).toBe(504);
  });

  it('a hard-isolated team (byokFallback: false) whose keys are busy still gets the 503', async () => {
    h.refuse.add('key-team-a');
    const s = await chat({ ...team('team-a'), byokFallback: false });
    expect(s.status).toBe(503);
  });

  it('an unknown model is a 400 for everyone else, whatever the gateway serves', async () => {
    const s = await embed(team('team-z'), 'no-such-model');
    expect(s.status).toBe(400);
  });
});
