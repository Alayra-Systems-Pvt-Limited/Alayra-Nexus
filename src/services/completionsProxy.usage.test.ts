/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── What a streamed answer is recorded as costing ─────────────────────────────────────────────
//
// Every other test of the streaming path asks what the caller received. This one asks what the
// operator is told it cost, which is the product: a gateway that serves the request perfectly and
// reports $0 has failed at the only job nothing else does.
//
// The two sources of output tokens are tested separately because they fail separately. A provider
// that volunteers a `usage` block in its stream is read from. A provider that does not — which
// includes OpenAI unless asked — is counted from the deltas, and that path had no test at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCacheConfig = vi.fn(async () => ({ enabled: false, ttlSeconds: 0 }));
vi.mock('./cache.service', () => ({ getCacheConfig: () => getCacheConfig() }));

// Only `setCached` is stubbed; everything else in the module is the real thing, so what the cache
// is asked to store is what it would really have stored.
const setCached = vi.fn(async () => {});
vi.mock('../lib/responseCache', async (o) => ({
  ...(await o<typeof import('../lib/responseCache')>()),
  getCached:  vi.fn(async () => null),
  setCached:  (...a: unknown[]) => setCached(...(a as [])),
}));

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

vi.mock('./modelCatalog.service', async (o) => ({
  ...(await o<typeof import('./modelCatalog.service')>()),
  noCapacityMessage: vi.fn(async () => 'No capacity.'),
}));

vi.mock('../lib/metrics', async (o) => ({ ...(await o<typeof import('../lib/metrics')>()) }));
vi.mock('../lib/tracing', async (o) => ({ ...(await o<typeof import('../lib/tracing')>()) }));

import { handleProxy } from './completionsProxy.service';
import { countTokens } from '../lib/tokenizer';

const ROUTE = {
  keyId: 'key-1', decryptedKey: 'sk-test', keyMask: '●●●●1234',
  baseUrl: 'https://api.openai.com/v1',
  modelString: 'gpt-4o', modelId: 'm-1', providerSlug: 'openai', tier: 'premium',
  authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
  wasDowngrade: false, isProbe: false, sticky: true, byok: false,
};

const messages = [{ role: 'user', content: 'hello' }];

/** Hands over `Uint8Array` chunks exactly as undici's reader does. */
function streamingUpstream(chunks: Uint8Array[]) {
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined }),
      }),
    },
  };
}

const sse   = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
/** One content delta, framed the way every OpenAI-compatible provider frames it. */
const delta = (content: string) => bytes(sse({ choices: [{ delta: { content } }] }));

/** A reply that swallows everything; this file is about the accounting, not the wire. */
function sink() {
  const r = {
    header: () => r, code: () => r, send: () => r, hijack() {},
    raw: { writeHead() {}, write() {}, end() {} },
  };
  return r as never;
}

/** Run a streamed answer through the proxy and return the usage row it recorded. */
async function stream(chunks: Uint8Array[]) {
  safeFetch.mockResolvedValue(streamingUpstream(chunks));
  await handleProxy({ messages, stream: true } as never, sink(), undefined, {}, undefined);
  return recordTokenUsage.mock.calls[0]?.[0] as unknown as { inputTokens: number; outputTokens: number };
}

beforeEach(() => {
  vi.clearAllMocks();
  discoverBestPool.mockResolvedValue(ROUTE);
  getCacheConfig.mockResolvedValue({ enabled: false, ttlSeconds: 0 });
});

describe('a provider that reports its own usage', () => {
  it('is believed', async () => {
    const row = await stream([
      delta('Hello'),
      delta(' world'),
      bytes(sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 7 } })),
      bytes('data: [DONE]\n\n'),
    ]);

    expect(row.inputTokens).toBe(11);
    expect(row.outputTokens).toBe(7);
  });

  it('is believed even when an earlier chunk carried a partial usage block', async () => {
    // Providers emit usage in the final chunk; a mid-stream one is the wrong one to bill from.
    const row = await stream([
      bytes(sse({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })),
      delta('y'),
      bytes(sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 9 } })),
      bytes('data: [DONE]\n\n'),
    ]);

    expect(row.outputTokens).toBe(9);
  });
});

describe('a provider that reports no usage at all', () => {
  // OpenAI is this provider. A streamed completion carries no `usage` block unless the request
  // asked for one with `stream_options: { include_usage: true }`, and Nexus does not ask.

  it('is counted from the words it actually sent', async () => {
    const answer = 'The capital of France is Paris.';
    const row = await stream([
      ...answer.split(' ').map((w, i) => delta(i ? ` ${w}` : w)),
      bytes('data: [DONE]\n\n'),
    ]);

    expect(row.outputTokens).toBe(countTokens(answer));
    expect(row.outputTokens).toBeGreaterThan(1);
  });

  it('counts an answer containing braces, quotes and newlines', async () => {
    // Code and JSON are most of what a coding gateway streams, and both are full of the characters
    // that defeat a regex reaching into a JSON string.
    const answer = 'function f() {\n  return "ok";\n}';
    const row = await stream([delta(answer), bytes('data: [DONE]\n\n')]);

    expect(row.outputTokens).toBe(countTokens(answer));
  });

  it('counts a long answer as long', async () => {
    // The failure this is really guarding: not an estimate that is a little off, but a constant.
    const answer = 'word '.repeat(2000);
    const row = await stream([delta(answer), bytes('data: [DONE]\n\n')]);

    expect(row.outputTokens).toBeGreaterThan(1000);
  });

  it('counts the last frame of a stream that ended without a trailing newline', async () => {
    // The proxy's loop only hands a frame over when it sees a newline, so the final one lives in
    // the tally's buffer until the flush after the loop. Without that flush this answer is billed
    // as one token again — for every provider that ends its stream on the frame rather than after
    // it, and for every stream cut short.
    const row = await stream([
      delta('The capital of France is'),
      bytes('data: {"choices":[{"delta":{"content":" Paris and it is lovely there"}}]}'),
    ]);

    expect(row.outputTokens).toBe(countTokens('The capital of France is Paris and it is lovely there'));
  });
});

describe('what gets kept for the next caller', () => {
  // The cache replays a stored answer to anyone who asks the same question, so a partial answer
  // stored once is served wrong repeatedly. Nothing had asserted that a stream is cached at all.

  it('stores a cleanly-read stream', async () => {
    getCacheConfig.mockResolvedValue({ enabled: true, ttlSeconds: 300 });
    await stream([delta('Hello'), delta(' world'), bytes('data: [DONE]\n\n')]);

    expect(setCached).toHaveBeenCalledTimes(1);
    expect((setCached.mock.calls[0][1] as { content: string }).content).toBe('Hello world');
  });

  it('refuses to store one with a hole in it', async () => {
    // A frame beyond a megabyte is dropped rather than held — that is how the tally stays bounded
    // against an upstream that never sends a newline. What is left is missing a piece, and a piece
    // missing from the cache is missing from every future answer too.
    getCacheConfig.mockResolvedValue({ enabled: true, ttlSeconds: 300 });
    await stream([
      delta('the beginning'),
      bytes(`data: {"choices":[{"delta":{"content":"${'x'.repeat(1_100_000)}`),   // never terminated
      delta('the end'),
    ]);

    expect(setCached).not.toHaveBeenCalled();
  });
});
