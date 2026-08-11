/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── The trace, filled by the real request path ────────────────────────────────────────────────
//
// The Playground's whole claim is "this is what the gateway actually did". That claim is only as
// good as the trace being written by the code that made each decision — so this file drives real
// requests through `handleProxy` and reads the trace that comes back, rather than unit-testing the
// shape of an object nobody filled.
//
// Two things are under test and they are not the same:
//
//   1. The trace says what happened — the right pool, the right key, the right cache verdict, and
//      a refusal reason that names the gate that refused.
//   2. Passing no trace changes nothing. Every existing caller does exactly that, and a request
//      path that behaves differently when observed is not the request path.
//
// And one thing that is neither, but matters more than both: the trace must never carry the
// provider credential. See #117 — `NexusRoute.decryptedKey` is the live key in plain text, and
// this is the first change that serialises routing metadata into an HTTP response.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join }         from 'node:path';

vi.mock('./cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 0 })) }));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));

const recordTokenUsage = vi.fn(async () => {});
vi.mock('./token.service', () => ({
  recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...(a as [])),
  recordOutcome:    vi.fn(async () => {}),
}));

const discoverBestPool = vi.fn();
// Every one of these is called as `void f(...).catch(...)` on the proxy path, so a stub returning
// undefined throws inside the code under test rather than failing an assertion about it.
vi.mock('./nexus.service', () => ({
  discoverBestPool: (...a: unknown[]) => discoverBestPool(...a),
  getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess:      vi.fn(async () => {}), reportServerFailure: vi.fn(async () => {}),
  reportRateLimit:    vi.fn(async () => {}), reportAuthFailure:   vi.fn(async () => {}),
  reportTierExhausted: vi.fn(async () => {}),
}));

vi.mock('../lib/sticky',    () => ({ sessionHash: () => 'session-1', setStickyKeyId: vi.fn(async () => {}) }));
vi.mock('../lib/admission', () => ({ reconcileTpm: vi.fn(async () => {}) }));

const safeFetch = vi.fn();
vi.mock('../lib/safeFetch', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));

// Partial: `resolveRequestedModel` is the real one (it is part of what the trace records), but the
// no-capacity SENTENCE reads the provider table to list what the gateway does have — a database
// call that has nothing to do with tracing and would otherwise decide whether this file passes.
vi.mock('./modelCatalog.service', async (o) => ({
  ...(await o<typeof import('./modelCatalog.service')>()),
  noCapacityMessage: vi.fn(async () => 'No capacity.'),
}));

vi.mock('../lib/metrics', async (o) => ({ ...(await o<typeof import('../lib/metrics')>()) }));
vi.mock('../lib/tracing', async (o) => ({ ...(await o<typeof import('../lib/tracing')>()) }));

import { handleProxy } from './completionsProxy.service';
import { newTrace }    from '../lib/requestTrace';

/** The plaintext credential. Present on every route below, and allowed nowhere near a trace. */
const SECRET = 'sk-ant-api03-THE-REAL-LIVE-CREDENTIAL-9f3a';

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

/** A route as `discoverBestPool` really returns one — credential included, as production has it. */
const ROUTE = {
  keyId: 'key-1', decryptedKey: SECRET, keyMask: '●●●●●●●●9f3a',
  baseUrl: 'https://api.anthropic.com/v1',
  modelString: 'claude-sonnet-4-5', modelId: 'm-1', providerSlug: 'anthropic', tier: 'premium',
  authHeader: 'x-api-key', authPrefix: '', extraHeaders: null,
  wasDowngrade: false, isProbe: false, sticky: true, byok: false,
};

const OK_BODY = {
  id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 4 },
};

const messages = [{ role: 'user', content: 'hello' }];

beforeEach(() => {
  vi.clearAllMocks();
  discoverBestPool.mockResolvedValue(ROUTE);
  safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => OK_BODY });
});

// ── What it records on a request that worked ──────────────────────────────────────────────────

describe('a request that reaches a provider', () => {
  it('names the pool, the model and the tier that served it', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(trace.route).toMatchObject({
      provider: 'anthropic', modelString: 'claude-sonnet-4-5', modelId: 'm-1', tier: 'premium',
    });
    expect(trace.outcome).toBe('success');
  });

  it('names the key by its mask, and carries the routing facts a person would ask about', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(trace.route?.keyId).toBe('key-1');
    expect(trace.route?.keyMask).toBe('●●●●●●●●9f3a');
    // Sticky is the answer to "why this key and not another one" — the second most common routing
    // question after "why this pool", and unanswerable from the response today.
    expect(trace.route?.sticky).toBe(true);
    expect(trace.route?.byok).toBe(false);
    expect(trace.route?.downgraded).toBe(false);
    expect(trace.route?.probe).toBe(false);
  });

  it('records the tokens the provider reported, not an estimate', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(trace.usage?.inputTokens).toBe(11);
    expect(trace.usage?.outputTokens).toBe(4);
  });

  it('times the provider call and the whole request separately', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    // Both present and both sane. The pair is the point: a slow request with a fast provider is a
    // gateway problem, and one number cannot say that.
    expect(trace.timing.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(trace.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(trace.timing.totalMs!).toBeGreaterThanOrEqual(trace.timing.ttfbMs!);
  });

  it('leaves the cost to be stamped by whoever records it', async () => {
    // token.service is mocked here, so nothing stamps the money — and the trace says "not known"
    // rather than zero. `$0.00` and "nobody has priced this" are different claims.
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(trace.usage?.estimatedUsd).toBeNull();
    expect(trace.usage?.priced).toBeUndefined();
  });

  it('hands the trace to recordTokenUsage, which is what fills the money in', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
    expect(recordTokenUsage.mock.calls[0][1]).toBe(trace);
  });
});

// ── What it records when the gateway refused ──────────────────────────────────────────────────

describe('a request the gateway refused', () => {
  it('says which gate refused it, and leaves the route empty', async () => {
    discoverBestPool.mockResolvedValue(null);
    const trace = newTrace();
    const reply = fakeReply();
    await handleProxy({ messages } as never, reply as never, undefined, {}, undefined, trace);

    expect(reply.statusCode).toBe(503);
    expect(trace.refusal?.status).toBe(503);
    expect(trace.refusal?.reason).toMatch(/capacity/i);
    // Nothing was routed, so nothing is claimed about a route. A partial trace is the correct
    // record of a request that stopped early.
    expect(trace.route).toBeUndefined();
    expect(trace.outcome).toBe('no_capacity');
  });

  it('reports an upstream refusal with the status the provider actually gave', async () => {
    safeFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'slow down' });
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    expect(trace.refusal).toEqual({ status: 429, reason: 'The provider answered 429.' });
    // The route IS recorded here — a provider that refused is still a provider that was chosen,
    // and "which key got rate-limited" is the whole question.
    expect(trace.route?.keyId).toBe('key-1');
  });
});

// ── The cache verdict ─────────────────────────────────────────────────────────────────────────

describe('why nothing was reused', () => {
  it('distinguishes a switched-off cache from a request that could never be cached', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    // The config mock has it disabled. `not-cacheable` would be a different answer to a different
    // question, and a panel that shows one word for both cannot tell an operator what to change.
    expect(trace.cache).toBe('disabled');
  });
});

// ── #117: the credential must not be able to reach it ─────────────────────────────────────────

describe('the provider credential never reaches the trace', () => {
  it('is absent after a successful request', async () => {
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    // Serialised, because that is what the Playground endpoint will do to it. A field-by-field
    // check would pass while a nested object smuggled the key through.
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(trace.route?.keyMask).not.toContain(SECRET);
  });

  it('is absent after a refusal that happened downstream of routing', async () => {
    safeFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    const trace = newTrace();
    await handleProxy({ messages } as never, fakeReply() as never, undefined, {}, undefined, trace);

    // The path most likely to be tempted into showing the key: the one where the key is the fault.
    expect(JSON.stringify(trace)).not.toContain(SECRET);
  });

  it('has nowhere to put it even if a future author tries', () => {
    // The type has no field for a credential, and the route is copied field by field rather than
    // spread. This asserts the second half — a spread would bring `decryptedKey` with it.
    const source = readFileSync(join(__dirname, 'completionsProxy.service.ts'), 'utf8');
    expect(source).not.toMatch(/trace\.route\s*=\s*\{\s*\.\.\.route/);
    expect(source).not.toMatch(/decryptedKey.*trace|trace.*decryptedKey/);
  });
});

// ── Passing nothing must change nothing ───────────────────────────────────────────────────────

describe('a caller that asks for no trace', () => {
  it('gets the same response as one that does', async () => {
    const withTrace = fakeReply();
    await handleProxy({ messages } as never, withTrace as never, undefined, {}, undefined, newTrace());

    vi.clearAllMocks();
    discoverBestPool.mockResolvedValue(ROUTE);
    safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => OK_BODY });

    const without = fakeReply();
    await handleProxy({ messages } as never, without as never);

    expect(without.statusCode).toBe(withTrace.statusCode);
    expect(without.payload).toEqual(withTrace.payload);
    expect(without.headers).toEqual(withTrace.headers);
  });

  it('still records usage, so observing a request is not what makes it count', async () => {
    await handleProxy({ messages } as never, fakeReply() as never);
    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
  });
});
