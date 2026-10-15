/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── A caller who hangs up stops the provider ──────────────────────────────────────────────────
//
// Real sockets on both sides, because the bug lived between them. The caller is an HTTP client
// that hangs up mid-answer; the gateway is a real Fastify server running the proxy; the provider is
// a loopback HTTP server streaming a long answer, reached through the real `fetch`. Nothing leaves
// the machine. Before the fix, /v1/messages (the Anthropic translator, which coding agents use) read
// the provider to the end after the caller had gone, and the provider billed all of it.
//
// The routes are the two lines each from routes/proxy.ts, without its API-key check, so the test
// needs no database. What is under test (handleProxy, the reply translator, Fastify's own reply)
// is the real thing.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('./cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: true, ttlSeconds: 60 })) }));
const setCached = vi.fn(async () => {});
vi.mock('../lib/responseCache', async (o) => ({
  ...(await o<typeof import('../lib/responseCache')>()),
  getCached: vi.fn(async () => null),
  setCached: (...a: unknown[]) => setCached(...(a as [])),
}));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));

const recordTokenUsage = vi.fn(async () => {});
const recordOutcome    = vi.fn(async () => {});
vi.mock('./token.service', () => ({
  recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...(a as [])),
  recordOutcome:    (...a: unknown[]) => recordOutcome(...(a as [])),
}));

const reportServerFailure = vi.fn(async () => {});
vi.mock('./nexus.service', () => ({
  discoverBestPool: vi.fn(async () => ROUTE),
  getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess: vi.fn(async () => {}), reportServerFailure: (...a: unknown[]) => reportServerFailure(...(a as [])),
  reportRateLimit: vi.fn(async () => {}), reportAuthFailure: vi.fn(async () => {}), reportTierExhausted: vi.fn(async () => {}),
}));
vi.mock('../lib/sticky',    () => ({ sessionHash: () => 'session-1', setStickyKeyId: vi.fn(async () => {}) }));
vi.mock('../lib/admission', () => ({ reconcileTpm: vi.fn(async () => {}) }));

/** Every chunk the gateway read from the provider, and whether the caller had already gone. */
const reads = { text: '', afterGone: 0 };
let callerGone = false;
let upstreamUrl = '';
const safeFetch = vi.fn();
vi.mock('../lib/safeFetch', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));

import { handleProxy } from './completionsProxy.service';
import { anthropicToOpenAI } from '../lib/anthropic';
import { createAnthropicReply } from '../lib/anthropicReply';
import { countTokens } from '../lib/tokenizer';

const ROUTE = {
  keyId: 'key-1', decryptedKey: 'sk-test', keyMask: '●●●●1234', baseUrl: 'http://127.0.0.1/v1',
  modelString: 'gpt-4o', modelId: 'm-1', providerSlug: 'openai', tier: 'premium',
  authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
  wasDowngrade: false, isProbe: false, sticky: false, byok: false,
};

// ── The provider: a long answer, one frame every 10ms, or a reply that is slow to arrive ────────

const FRAMES = 200;
const word = (i: number) => `w${i} `;
const provider = { frames: 0, closedAt: 0, finished: false, mode: 'stream' as 'stream' | 'slow-head' | 'slow-body' };
let upstream: http.Server;

function serveProvider(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.resume();
  const timers: ReturnType<typeof setTimeout>[] = [];
  res.on('close', () => { timers.forEach(clearInterval); if (!provider.finished) provider.closedAt = Date.now(); });
  if (provider.mode !== 'stream') {
    if (provider.mode === 'slow-body') res.writeHead(200, { 'content-type': 'application/json' });
    return;                                                      // and then nothing, for a long time
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  timers.push(setInterval(() => {
    if (provider.frames === FRAMES) { provider.finished = true; res.end('data: [DONE]\n\n'); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word(provider.frames++) } }] })}\n\n`);
  }, 10));
}

/** The real fetch, with the body's reads counted. */
async function fetchCounting(_url: string, init: RequestInit) {
  const res = await fetch(upstreamUrl, init);
  const body = res.body!;
  return {
    ok: res.ok, status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text(),
    body: { getReader() {
      const r = body.getReader();
      return { read: async () => {
        const x = await r.read();
        if (!x.done) { reads.text += new TextDecoder().decode(x.value); if (callerGone) reads.afterGone++; }
        return x;
      } };
    } },
  };
}

// ── The gateway ───────────────────────────────────────────────────────────────────────────────

let gateway: FastifyInstance;
let gatewayUrl = '';

beforeAll(async () => {
  upstream = http.createServer(serveProvider);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/chat/completions`;

  gateway = Fastify();
  // Registered before the proxy's own listener, so it runs first: after this, a read is too late.
  gateway.addHook('onRequest', async (_req, reply) => { reply.raw.once('close', () => { callerGone = true; }); });
  gateway.post('/v1/chat/completions', async (req, reply) => handleProxy(req.body as never, reply));
  gateway.post('/v1/messages', async (req, reply) =>
    handleProxy(anthropicToOpenAI(req.body as Record<string, unknown>) as never, createAnthropicReply(reply).reply));
  gatewayUrl = await gateway.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => { await gateway?.close(); await new Promise((r) => upstream?.close(r)); });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(provider, { frames: 0, closedAt: 0, finished: false, mode: 'stream' });
  Object.assign(reads, { text: '', afterGone: 0 });
  callerGone = false;
  safeFetch.mockImplementation(fetchCounting);
});

/** POST, then hang up once `enough` says so (or after `ms`). Resolves with what arrived and when. */
function callAndHangUp(path: string, body: object, enough: (received: string) => boolean, ms = 5_000) {
  return new Promise<{ received: string; hungUpAt: number }>((resolve) => {
    let received = '';
    const req = http.request(`${gatewayUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const hangUp = () => { if (req.destroyed) return; req.destroy(); resolve({ received, hungUpAt: Date.now() }); };
    req.on('response', (res) => res.on('data', (c: Buffer) => { received += c.toString(); if (enough(received)) hangUp(); }));
    req.on('error', () => {});
    setTimeout(hangUp, ms);
    req.end(JSON.stringify(body));
  });
}

/** The answer text in a stream of OpenAI frames, read the way the stream tally reads it. */
const answerIn = (sse: string) => sse.split('\n').filter((l) => l.startsWith('data: {')).map((l) => {
  try { return (JSON.parse(l.slice(6)) as { choices: { delta: { content: string } }[] }).choices[0].delta.content; } catch { return ''; }
}).join('');

const usageRow = () => recordTokenUsage.mock.calls[0]?.[0] as unknown as { outputTokens: number; outcome: string };
const fullAnswer = Array.from({ length: FRAMES }, (_, i) => word(i)).join('');
const frames = (s: string, marker: string) => s.split(marker).length - 1;

describe.each([
  ['/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'go' }] }, 'data: {"choices"'],
  ['/v1/messages', { model: 'alayra-nexus-1', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] }, 'event: content_block_delta'],
] as const)('a caller who hangs up mid-stream on %s', (path, body, marker) => {
  it('closes the provider socket within a bounded time, reads no more, and records what was delivered', async () => {
    const { received, hungUpAt } = await callAndHangUp(path, body, (r) => frames(r, marker) >= 3);
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    // The provider's socket closed promptly, long before its answer would have ended.
    expect(provider.closedAt, 'the provider socket never closed').toBeGreaterThan(0);
    expect(provider.closedAt - hungUpAt).toBeLessThan(1_000);
    expect(provider.finished).toBe(false);
    expect(provider.frames).toBeLessThan(FRAMES / 2);

    // Nothing was read from the provider after the gateway saw the caller go.
    expect(reads.afterGone).toBe(0);

    // The row is a cancel, billed for exactly what was read before it, not the whole answer.
    const row = usageRow();
    expect(row.outcome).toBe('client_cancelled');
    expect(row.outputTokens).toBe(Math.max(1, countTokens(answerIn(reads.text))));
    expect(row.outputTokens).toBeLessThan(countTokens(fullAnswer));
    expect(frames(received, marker)).toBeGreaterThanOrEqual(3);

    // Not the key's fault, and a partial answer is never cached for the next caller.
    expect(reportServerFailure).not.toHaveBeenCalled();
    expect(setCached).not.toHaveBeenCalled();
  });
});

describe('a caller who hangs up before the provider has answered', () => {
  it.each([['slow-head'], ['slow-body']] as const)('%s: closes the provider socket and records a cancel, not a provider error', async (mode) => {
    provider.mode = mode;
    const { hungUpAt } = await callAndHangUp('/v1/chat/completions', { messages: [{ role: 'user', content: 'go' }] }, () => false, 150);
    await vi.waitFor(() => expect(recordOutcome).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(provider.closedAt, 'the provider socket never closed').toBeGreaterThan(0);
    expect(provider.closedAt - hungUpAt).toBeLessThan(1_000);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'client_cancelled' }));
    expect(recordTokenUsage).not.toHaveBeenCalled();
    expect(reportServerFailure).not.toHaveBeenCalled();
  });
});

describe('a caller who stays', () => {
  it('still gets the whole answer, recorded as a success', async () => {
    const { received } = await callAndHangUp('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'go' }] }, (r) => r.includes('[DONE]'), 15_000);
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(answerIn(received)).toBe(fullAnswer);
    expect(provider.finished).toBe(true);
    expect(usageRow().outcome).toBe('success');
    // And it is cached, which is what makes "a cancelled answer is not cached" above mean something.
    expect(setCached).toHaveBeenCalledTimes(1);
  }, 20_000);
});
