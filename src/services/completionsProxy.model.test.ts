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

/**
 * What the chat endpoint does with the caller's `model`.
 *
 * It used to do one thing: reject anything that was not `alayra-nexus-1` or one of its two
 * aliases. That rejection included `"auto"` — the value the dashboard's own Quick Start
 * told every new operator to send — so the first request most people ever made to this
 * gateway came back 400.
 *
 * `lib/responseCache` is deliberately NOT mocked. The claim that a pinned model reaches the
 * cache key is the one that fails silently if it is wrong: the request succeeds, and the
 * caller is simply handed a different model's answer. Asserting it against the real key
 * derivation is the only way to know.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ resolution: { kind: 'auto' } as Record<string, unknown> }));

vi.mock('./cache.service', () => ({ getCacheConfig: vi.fn(async () => ({ enabled: true, ttlSeconds: 3600 })) }));
vi.mock('./byok.service', () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service', () => ({ getSsrfPolicy: vi.fn(async () => ({})) }));
vi.mock('./token.service', () => ({ recordTokenUsage: vi.fn(async () => {}), recordOutcome: vi.fn(async () => {}) }));

const discoverBestPool = vi.fn(async () => null);
vi.mock('./nexus.service', () => ({
  discoverBestPool: (...a: unknown[]) => discoverBestPool(...(a as [])),
  getNextCooldownSeconds: vi.fn(async () => 42),
  reportSuccess: vi.fn(), reportServerFailure: vi.fn(), reportRateLimit: vi.fn(),
  reportAuthFailure: vi.fn(), reportTierExhausted: vi.fn(async () => {}),
}));

// Resolution is driven against the real registry in modelCatalog.service.test.ts. Here the
// subject is what the chat handler DOES with each answer, so the answer is injected.
vi.mock('./modelCatalog.service', () => ({
  resolveRequestedModel: vi.fn(async () => h.resolution),
  unknownModelError: (r: { requested: string; available: string[] }) =>
    ({ error: `Unknown model "${r.requested}". Send "alayra-nexus-1" …`, available: r.available }),
  noCapacityMessage: vi.fn(async (o: { pinnedModelId: string | null }) =>
    (o.pinnedModelId ? `Model "${o.pinnedModelId}" is configured, but …` : 'All API keys are currently rate-limited.')),
}));

vi.mock('../lib/metrics', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/metrics')>()) }));
vi.mock('../lib/tracing', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/tracing')>()) }));

import { handleProxy } from './completionsProxy.service';
import { responseCacheKey, setCached, type CachedCompletion } from '../lib/responseCache';

function fakeReply() {
  const headers: Record<string, string> = {};
  const r = {
    headers, statusCode: 0, payload: undefined as unknown,
    header(k: string, v: string) { headers[k] = v; return r; },
    code(c: number) { r.statusCode = c; return r; },
    send(p: unknown) { r.payload = p; return r; },
    hijack() {},
    raw: { writeHead() {}, write() {}, end() {} },
  };
  return r;
}

const messages = [{ role: 'user', content: 'hello' }];

beforeEach(() => {
  vi.clearAllMocks();
  h.resolution = { kind: 'auto' };
  discoverBestPool.mockResolvedValue(null);
});

describe('the caller names a model', () => {
  it('refuses a model this gateway cannot serve, without routing anywhere', async () => {
    h.resolution = { kind: 'unknown', requested: 'llama-99b', available: ['alayra-nexus-1'] };
    const reply = fakeReply();
    await handleProxy({ model: 'llama-99b', messages } as never, reply as never);

    expect(reply.statusCode).toBe(400);
    expect((reply.payload as { error: string }).error).toContain('llama-99b');
    // The point of the 400: no provider was called, so nobody was billed for a request
    // that could only have been answered by a model the caller did not ask for.
    expect(discoverBestPool).not.toHaveBeenCalled();
  });

  it('pins routing to the model that was asked for', async () => {
    h.resolution = { kind: 'pinned', model: { id: 'gpt4o' } };
    await handleProxy({ model: 'gpt-4o', messages } as never, fakeReply() as never);

    expect(discoverBestPool).toHaveBeenCalledWith(
      expect.any(Number), expect.anything(), expect.anything(), 'chat', null, null, 'gpt4o',
    );
  });

  it('leaves routing free when the caller auto-routes', async () => {
    await handleProxy({ model: 'auto', messages } as never, fakeReply() as never);

    const args = discoverBestPool.mock.calls[0] as unknown[];
    expect(args[6]).toBeNull();
  });

  it('names the pinned model when nothing can serve it', async () => {
    h.resolution = { kind: 'pinned', model: { id: 'gpt4o' } };
    const reply = fakeReply();
    await handleProxy({ model: 'gpt-4o', messages } as never, reply as never);

    expect(reply.statusCode).toBe(503);
    expect((reply.payload as { error: string }).error).toContain('gpt4o');
  });
});

describe('a pinned model changes the cache identity', () => {
  const cached = (content: string): CachedCompletion => ({
    id: 'chatcmpl-1', created: 1, model: 'gpt-4o', provider: 'openai',
    content, finishReason: 'stop', promptTokens: 10, completionTokens: 5,
  });

  it('does not replay one model\'s answer to a request for another', async () => {
    // Store an answer produced for gpt4o, then ask the SAME prompt pinned to sonnet. With a
    // constant model in the cache key — as it was before pinning existed — this hits, and
    // the caller is handed the wrong model's text with a 200 and no warning anywhere.
    const body = { model: 'gpt-4o', messages, temperature: 0 };
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared', 'gpt4o'), cached('answered by gpt-4o'), 3600);

    h.resolution = { kind: 'pinned', model: { id: 'sonnet' } };
    const reply = fakeReply();
    await handleProxy({ ...body, model: 'claude-sonnet-4-5' } as never, reply as never);

    expect(reply.headers['X-Nexus-Cache']).not.toBe('hit');
  });

  it('still serves a pinned request from its own cache entry', async () => {
    const body = { model: 'gpt-4o', messages, temperature: 0 };
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared', 'gpt4o'), cached('answered by gpt-4o'), 3600);

    h.resolution = { kind: 'pinned', model: { id: 'gpt4o' } };
    const reply = fakeReply();
    await handleProxy(body as never, reply as never);

    expect(reply.headers['X-Nexus-Cache']).toBe('hit');
    expect((reply.payload as { choices: Array<{ message: { content: string } }> }).choices[0].message.content)
      .toBe('answered by gpt-4o');
  });

  it('keeps auto-routed entries reachable, so upgrading loses no cache', async () => {
    const body = { model: 'alayra-nexus-1', messages, temperature: 0 };
    // Written the way every pre-pinning entry was: namespace only, no model identity.
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared'), cached('answered before the upgrade'), 3600);

    const reply = fakeReply();
    await handleProxy(body as never, reply as never);

    expect(reply.headers['X-Nexus-Cache']).toBe('hit');
  });
});
