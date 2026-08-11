/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── The capturing reply, facing the real proxy ────────────────────────────────────────────────
//
// `capturingReply.test.ts` drives the wrapper by hand: it calls the methods in the order the proxy
// calls them, with the chunk types the proxy writes. That is worth having, and it is not enough.
//
// It is not enough because it can only assert what its author believed about `handleProxy`, and
// that is precisely how the last bug in this seam shipped. The Anthropic wrapper's tests all wrote
// strings; the proxy writes bytes; every test passed and every streamed reply came back empty. A
// stand-in verified only against a belief about its caller verifies the belief, not the caller.
//
// So this file hands the capturing reply to the real `handleProxy` and reads what came out. It is
// the same harness as `completionsProxy.trace.test.ts` — same mocks, same route, same upstream —
// because the point is the code between them, which is not mocked.
//
// The claim it exists to defend: what the Playground shows is what a caller on the wire would have
// received. Not similar to it. The same.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 0 })) }));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));

vi.mock('./token.service', () => ({
  recordTokenUsage: vi.fn(async () => {}),
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

import { handleProxy }          from './completionsProxy.service';
import { createCapturingReply } from '../lib/capturingReply';

const SECRET = 'sk-ant-api03-THE-REAL-LIVE-CREDENTIAL-9f3a';

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

/** A reply that records, standing in for the socket a real caller is on. */
function realReply() {
  const headers: Record<string, string> = {};
  let sse = '';
  const decoder = new TextDecoder();
  const r = {
    headers, statusCode: 0, payload: undefined as unknown, ended: false, sse: () => sse,
    header(k: string, v: string) { headers[k.toLowerCase()] = v; return r; },
    code(c: number) { r.statusCode = c; return r; },
    send(p: unknown) { r.payload = p; return r; },
    hijack() {},
    raw: {
      writeHead(status: number, h?: Record<string, string>) {
        r.statusCode = status;
        for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v;
      },
      write(c: string | Uint8Array) { sse += typeof c === 'string' ? c : decoder.decode(c, { stream: true }); },
      end() { r.ended = true; },
    },
  };
  return r;
}

/**
 * An upstream that streams, handing over `Uint8Array` chunks exactly as undici's reader does.
 *
 * Not `Buffer`. The distinction is the whole of #120: `Buffer.prototype.toString` decodes and
 * `Uint8Array.prototype.toString` lists byte values, so a harness that yielded Buffers would pass
 * against the very bug this is here to catch.
 */
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

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  vi.clearAllMocks();
  discoverBestPool.mockResolvedValue(ROUTE);
  safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => OK_BODY });
});

describe('a non-streaming request', () => {
  it('captures the completion the caller would have received', async () => {
    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages } as never, reply, undefined, {}, undefined);

    expect(captured.status).toBe(200);
    expect(captured.ended).toBe(true);
    expect(captured.streamed).toBe(false);
    expect(captured.payload).toMatchObject({
      choices: [{ message: { content: 'hi' } }],
      usage:   { prompt_tokens: 11, completion_tokens: 4 },
    });
  });

  it('captures the X-Nexus headers that say what served it', async () => {
    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages } as never, reply, undefined, {}, undefined);

    expect(captured.headers['x-nexus-model']).toBe('claude-sonnet-4-5');
    expect(captured.headers['x-nexus-provider']).toBe('anthropic');
  });

  it('captures an upstream refusal with its status and its body', async () => {
    // The provider's own error text, forwarded verbatim as a string. The case a Playground user
    // most needs to read, and the one a capture assuming JSON would lose.
    safeFetch.mockResolvedValue({
      ok: false, status: 401, text: async () => '{"error":{"message":"invalid x-api-key"}}',
    });

    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages } as never, reply, undefined, {}, undefined);

    expect(captured.status).toBe(401);
    expect(String(captured.payload)).toContain('invalid x-api-key');
  });

  it('captures a refusal raised before any provider was called', async () => {
    // No pool at all: the request never leaves the gateway. The Playground has to show this as
    // clearly as it shows a success, since it is the likeliest thing a new operator hits.
    discoverBestPool.mockResolvedValue(null);

    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages } as never, reply, undefined, {}, undefined);

    expect(captured.status).toBe(503);
    expect(captured.ended).toBe(true);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe('a streaming request', () => {
  beforeEach(() => {
    safeFetch.mockResolvedValue(streamingUpstream([
      bytes(sse({ choices: [{ delta: { role: 'assistant', content: 'Hello' } }] })),
      bytes(sse({ choices: [{ delta: { content: ' world' } }] })),
      bytes('data: [DONE]\n\n'),
    ]));
  });

  it('captures the stream as text, not as a list of byte values', async () => {
    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages, stream: true } as never, reply, undefined, {}, undefined);

    expect(captured.streamed).toBe(true);
    expect(captured.ended).toBe(true);
    expect(captured.sse).toContain('Hello');
    expect(captured.sse).toContain(' world');
    expect(captured.sse).toContain('[DONE]');
    // What the old `.toString()` produced. Asserting its absence, because its presence was not an
    // error — it was a plausible-looking string that parsed to nothing.
    expect(captured.sse).not.toMatch(/\d+,\d+,\d+,\d+/);
  });

  it('relays chunks while the request is still running', async () => {
    const seen: string[] = [];
    const { reply } = createCapturingReply({ onChunk: (c) => seen.push(c) });
    await handleProxy({ messages, stream: true } as never, reply, undefined, {}, undefined);

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join('')).toContain('Hello');
  });

  it('keeps a character the upstream split across two chunks', async () => {
    const whole = bytes(sse({ choices: [{ delta: { content: 'hi 👋' } }] }));
    const cut   = whole.length - 4;
    safeFetch.mockResolvedValue(streamingUpstream([whole.slice(0, cut), whole.slice(cut)]));

    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages, stream: true } as never, reply, undefined, {}, undefined);

    expect(captured.sse).toContain('👋');
    expect(captured.sse).not.toContain('�');
  });
});

// ── The claim the Playground rests on ─────────────────────────────────────────────────────────

describe('what a captured run promises', () => {
  it('is byte for byte what a caller on the wire receives, non-streaming', async () => {
    const real = realReply();
    await handleProxy({ messages } as never, real as never, undefined, {}, undefined);

    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages } as never, reply, undefined, {}, undefined);

    expect(captured.status).toBe(real.statusCode);
    expect(captured.payload).toEqual(real.payload);
    expect(captured.headers).toEqual(real.headers);
  });

  it('is byte for byte what a caller on the wire receives, streaming', async () => {
    const chunks = () => [
      bytes(sse({ choices: [{ delta: { content: 'Hello' } }] })),
      bytes('data: [DONE]\n\n'),
    ];

    safeFetch.mockResolvedValue(streamingUpstream(chunks()));
    const real = realReply();
    await handleProxy({ messages, stream: true } as never, real as never, undefined, {}, undefined);

    safeFetch.mockResolvedValue(streamingUpstream(chunks()));
    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages, stream: true } as never, reply, undefined, {}, undefined);

    expect(captured.sse).toBe(real.sse());
    expect(captured.status).toBe(real.statusCode);
    expect(captured.headers).toEqual(real.headers);
  });

  it('never holds the provider credential', async () => {
    // The capture is bound for an HTTP response. `NexusRoute.decryptedKey` is the live key in
    // plaintext and sits one field away from everything the proxy touches — see #117.
    safeFetch.mockResolvedValue(streamingUpstream([bytes(sse({ choices: [{ delta: { content: 'hi' } }] }))]));

    const { reply, captured } = createCapturingReply();
    await handleProxy({ messages, stream: true } as never, reply, undefined, {}, undefined);

    expect(JSON.stringify(captured)).not.toContain(SECRET);
  });
});
