/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── What bounds one streamed request ──────────────────────────────────────────────────────────
//
// The limits are set to milliseconds here rather than driven with fake timers, because the thing
// under test is a race between a real reader, real timers and a real abort signal. Fake timers
// would let the assertions pass while the ordering that matters never happened.
//
// The env has to be set before the service is imported, because the module reads these once at
// load — and `vi.hoisted` is the only way to get there. Plain assignments at the top of the file
// are not enough: `import` declarations are hoisted above them, so the service would read the
// production defaults and every test here would sit for ten minutes waiting for a ceiling that had
// already been raised. It did exactly that on the first run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both guards have to be able to win, or one of these tests is only ever measuring the other. The
// gaps below are chosen against these: 30ms between chunks never reaches the 200ms idle guard, so
// a stream that keeps dripping can only be stopped by the ceiling; silence reaches the idle guard
// at 200ms, well before the ceiling at 500ms.
vi.hoisted(() => {
  process.env.UPSTREAM_STREAM_IDLE_MS = '200';
  process.env.UPSTREAM_STREAM_MAX_MS  = '500';
  process.env.UPSTREAM_TTFT_MS        = '5000';
});

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

const ROUTE = {
  keyId: 'key-1', decryptedKey: 'sk-test', keyMask: '●●●●1234',
  baseUrl: 'https://api.openai.com/v1',
  modelString: 'gpt-4o', modelId: 'm-1', providerSlug: 'openai', tier: 'premium',
  authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
  wasDowngrade: false, isProbe: false, sticky: true, byok: false,
};

const messages = [{ role: 'user', content: 'hello' }];
const sse   = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
const delta = (content: string) => bytes(sse({ choices: [{ delta: { content } }] }));

/** A reply that records everything written to it, standing in for the caller's socket. */
function recordingReply() {
  let written = '';
  const decoder = new TextDecoder();
  const r = {
    written: () => written, ended: false,
    header: () => r, code: () => r, send: () => r, hijack() {},
    raw: {
      writeHead() {},
      write(c: string | Uint8Array) { written += typeof c === 'string' ? c : decoder.decode(c, { stream: true }); },
      end() { r.ended = true; },
    },
  };
  return r;
}

/**
 * An upstream that hands over one chunk every `gapMs`, and then — if asked — never says anything
 * again. That last part is the whole of #126: a provider that goes quiet without closing.
 *
 * It is built around the proxy's own abort signal so that aborting really does end the read, the
 * way undici's does. A mock that ignored the signal would hang the test rather than fail it.
 */
function drippingUpstream(chunks: Uint8Array[], gapMs: number, hangAtEnd = false) {
  return async (_url: unknown, opts: { signal: AbortSignal }) => {
    const { signal } = opts;
    let i = 0;
    return {
      ok: true, status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
            if (signal.aborted) { reject(new Error('The operation was aborted')); return; }

            // No timer at all once the chunks run out and this upstream is meant to go quiet: the
            // read simply never settles, and only the abort listener can end it. That is what a
            // provider holding a connection open without sending looks like.
            const timer = i >= chunks.length && hangAtEnd ? undefined : setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true });
            }, gapMs);

            function onAbort(): void {
              if (timer) clearTimeout(timer);
              reject(new Error('The operation was aborted'));
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        }),
      },
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  discoverBestPool.mockResolvedValue(ROUTE);
});

describe('a request that runs too long', () => {
  it('is cut at the ceiling, even though it was never idle', async () => {
    // The exact shape of #126. Chunks arrive every 30ms against a 200ms idle guard, so the idle
    // guard never comes close to firing — and before the ceiling existed, nothing else would have.
    // A provider dripping like this held a connection, a slot and a token reservation indefinitely.
    safeFetch.mockImplementation(drippingUpstream(Array.from({ length: 200 }, () => delta('word ')), 30));

    const reply = recordingReply();
    const started = Date.now();
    await handleProxy({ messages, stream: true } as never, reply as never, undefined, {}, undefined);
    const elapsed = Date.now() - started;

    expect(elapsed, 'ran past the ceiling').toBeLessThan(1500);
    expect(reply.ended).toBe(true);
  });

  it('says why, rather than stopping mid-sentence', async () => {
    safeFetch.mockImplementation(drippingUpstream(Array.from({ length: 200 }, () => delta('word ')), 30));

    const reply = recordingReply();
    await handleProxy({ messages, stream: true } as never, reply as never, undefined, {}, undefined);

    expect(reply.written()).toContain('stream_duration');
    expect(reply.written()).toContain('incomplete');
    // No `[DONE]`: to most clients that reads as a clean finish, which is the opposite of the truth.
    expect(reply.written()).not.toContain('[DONE]');
  });

  it('still bills for the tokens that were delivered', async () => {
    // The provider will invoice for them whether or not Nexus finished reading. Recording nothing
    // would make a cut request free, and a way to get free tokens is a way to get free tokens.
    safeFetch.mockImplementation(drippingUpstream(Array.from({ length: 200 }, () => delta('word ')), 30));

    const reply = recordingReply();
    await handleProxy({ messages, stream: true } as never, reply as never, undefined, {}, undefined);

    const row = recordTokenUsage.mock.calls[0]?.[0] as unknown as { outputTokens: number; outcome: string };
    expect(row.outputTokens).toBeGreaterThan(1);
    expect(row.outcome).toBe('upstream_error');
  });
});

describe('a provider that goes quiet', () => {
  it('is cut at the idle guard, and says which guard it was', async () => {
    // Two chunks and then silence forever. The distinction from the case above matters to whoever
    // reads the message: one is "this provider stopped", the other is "your answer was too long".
    safeFetch.mockImplementation(drippingUpstream([delta('hello'), delta(' there')], 5, true));

    const reply = recordingReply();
    await handleProxy({ messages, stream: true } as never, reply as never, undefined, {}, undefined);

    expect(reply.written()).toContain('"hello"');
    expect(reply.written()).toContain('" there"');
    expect(reply.written()).toContain('stream_idle');
    expect(reply.ended).toBe(true);
  });
});

describe('a request that finishes normally', () => {
  it('is not cut, and carries no error frame', async () => {
    // The regression that would matter most: a ceiling that fires on ordinary traffic would break
    // every long answer in production while every test about the ceiling still passed.
    safeFetch.mockImplementation(drippingUpstream([delta('all'), delta(' done'), bytes('data: [DONE]\n\n')], 5));

    const reply = recordingReply();
    await handleProxy({ messages, stream: true } as never, reply as never, undefined, {}, undefined);

    // Each delta is its own frame, so the words are never adjacent on the wire — asserting on the
    // joined text would be asserting about a format the caller never sees.
    expect(reply.written()).toContain('"all"');
    expect(reply.written()).toContain('" done"');
    expect(reply.written()).toContain('[DONE]');
    expect(reply.written()).not.toContain('upstream_timeout');

    const row = recordTokenUsage.mock.calls[0]?.[0] as unknown as { outcome: string };
    expect(row.outcome).toBe('success');
  });
});
