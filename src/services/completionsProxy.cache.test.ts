import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The response cache, exercised through the real request path.
 *
 * `completionsProxy.service.ts` had no test file at all — the whole proxy, including the cache. So
 * "a stored entry is found again by an identical request" had never been asserted anywhere, which
 * is precisely the claim that matters: the cache is worth nothing if what it writes is not what it
 * later looks up.
 *
 * Deliberately, `lib/responseCache` is NOT mocked. The key derivation and the store are the things
 * under suspicion, so mocking them would assume the answer. Only the surroundings are faked —
 * config, scope, guardrails, budget, metrics, usage recording — and a cache HIT returns before
 * routing is ever consulted, so no provider needs to exist.
 */

const getCacheConfig = vi.fn();
vi.mock('./cache.service', () => ({ getCacheConfig: () => getCacheConfig() }));

vi.mock('./byok.service', () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service', () => ({ getSsrfPolicy: vi.fn(async () => ({})) }));

const recordTokenUsage = vi.fn(async () => {});
vi.mock('./token.service', () => ({
  recordTokenUsage: (p: unknown) => recordTokenUsage(p),
  recordOutcome:    vi.fn(async () => {}),
}));

// Routing must never be reached on a hit. If it is, the cache did not serve the request.
const discoverBestPool = vi.fn();
vi.mock('./nexus.service', () => ({
  discoverBestPool: (...a: unknown[]) => discoverBestPool(...a),
  getNextCooldownSeconds: vi.fn(), reportSuccess: vi.fn(), reportServerFailure: vi.fn(),
  reportRateLimit: vi.fn(), reportAuthFailure: vi.fn(), reportTierExhausted: vi.fn(),
}));

// Partial mocks: the real modules export more than this test can guess at, and stubbing them
// wholesale produced "no export is defined" rather than anything about caching.
vi.mock('../lib/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/metrics')>()),
}));
vi.mock('../lib/tracing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tracing')>()),
}));

import { handleProxy } from './completionsProxy.service';
import { responseCacheKey, setCached, type CachedCompletion } from '../lib/responseCache';

function fakeReply() {
  const headers: Record<string, string> = {};
  const r = {
    headers,
    statusCode: 0,
    payload: undefined as unknown,
    header(k: string, v: string) { headers[k] = v; return r; },
    code(c: number) { r.statusCode = c; return r; },
    send(p: unknown) { r.payload = p; return r; },
    hijack() {},
    raw: { writeHead() {}, write() {}, end() {} },
  };
  return r;
}

const entry: CachedCompletion = {
  id: 'chatcmpl-1', created: 1, model: 'gpt-4o', provider: 'openai',
  content: 'the cached answer', finishReason: 'stop', promptTokens: 10, completionTokens: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  getCacheConfig.mockResolvedValue({ enabled: true, ttlSeconds: 3600 });
});

describe('response cache — what is stored is what is served', () => {
  it('serves an identical request from the cache, without routing to any provider', async () => {
    const body = { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'hello' }], temperature: 0 };

    // Store under exactly the key the proxy will derive for this body — the real function, the
    // real store. If key derivation and lookup ever disagree, this is where it shows.
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared'), entry, 3600);

    const reply = fakeReply();
    await handleProxy(body as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['X-Nexus-Cache']).toBe('hit');
    expect(discoverBestPool).not.toHaveBeenCalled();

    const payload = reply.payload as { choices: Array<{ message: { content: string } }> };
    expect(payload.choices[0].message.content).toBe('the cached answer');
  });

  it('records the hit as cached, so the dashboard can show a hit rate and a saving', async () => {
    const body = { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'count me' }] };
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared'), entry, 3600);

    await handleProxy(body as never, fakeReply() as never);

    // savedUsd is derived from `cached: true` plus a registry price lookup, and the lookup matches
    // on modelName — so a hit that records the wrong model name silently saves $0.
    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cached: true, modelName: 'gpt-4o', provider: 'openai' }),
    );
  });

  it('does not serve one prompt\'s answer for a different prompt', async () => {
    const stored = { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'hello' }] };
    await setCached(responseCacheKey(stored as Record<string, unknown>, 'shared'), entry, 3600);

    const different = { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'something else' }] };
    const reply = fakeReply();
    await handleProxy(different as never, reply as never).catch(() => {});

    expect(reply.headers['X-Nexus-Cache']).not.toBe('hit');
  });

  it('never reads the cache when caching is switched off', async () => {
    getCacheConfig.mockResolvedValue({ enabled: false, ttlSeconds: 3600 });
    const body = { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'hello' }] };
    await setCached(responseCacheKey(body as Record<string, unknown>, 'shared'), entry, 3600);

    const reply = fakeReply();
    await handleProxy(body as never, reply as never).catch(() => {});

    // A stored entry must stay unread while the feature is off, or turning it off would do nothing.
    expect(reply.headers['X-Nexus-Cache']).not.toBe('hit');
  });
});
