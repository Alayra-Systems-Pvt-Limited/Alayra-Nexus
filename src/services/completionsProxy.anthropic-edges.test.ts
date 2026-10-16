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

// The native Anthropic path where it can go wrong: which way routing sends it, how Anthropic's errors
// count against a key, what a tenant may read of them, streams that fail or stall, the response cache
// and the per-minute token budget. Real sockets on loopback, as in the passthrough test; no network.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env.UPSTREAM_STREAM_IDLE_MS = '200'; process.env.UPSTREAM_TTFT_MS = '800'; });

const store = new Map<string, unknown>();
vi.mock('./cache.service', () => ({ getCacheConfig: vi.fn(async () => ({ enabled: true, ttlSeconds: 60 })) }));
vi.mock('../lib/responseCache', async (o) => ({
  ...(await o<typeof import('../lib/responseCache')>()),
  getCached: vi.fn(async (key: string) => store.get(key) ?? null),
  setCached: vi.fn(async () => {}),
}));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));
const recordTokenUsage = vi.fn(async () => {});
vi.mock('./token.service', () => ({ recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...(a as [])), recordOutcome: vi.fn(async () => {}) }));
const breaker = vi.hoisted(() => ({
  reportSuccess: vi.fn(async () => {}), reportServerFailure: vi.fn(async () => {}),
  reportRateLimit: vi.fn(async () => {}), reportAuthFailure: vi.fn(async () => {}),
}));
const route: Record<string, unknown> = {};
vi.mock('./nexus.service', () => ({
  discoverBestPool: vi.fn(async () => route), getNextCooldownSeconds: vi.fn(async () => 30), reportTierExhausted: vi.fn(async () => {}),
  ...breaker,
}));
const setStickyKeyId = vi.fn(async () => {});
vi.mock('../lib/sticky', () => ({ sessionHash: () => 'session-1', setStickyKeyId: (...a: unknown[]) => setStickyKeyId(...(a as [])) }));
const reconcileTpm = vi.fn(async () => {});
vi.mock('../lib/admission', () => ({ reconcileTpm: (...a: unknown[]) => reconcileTpm(...(a as [])) }));
vi.mock('../lib/safeFetch', () => ({ safeFetch: (url: string, init: RequestInit) => fetch(url, init) }));
vi.mock('./modelCatalog.service', async (o) => ({
  ...(await o<typeof import('./modelCatalog.service')>()),
  resolveRequestedModel: vi.fn(async () => ({ kind: 'auto' })),
}));
vi.mock('./model.service', () => ({ getModelRegistry: vi.fn(async () => []) }));

import { handleAnthropicMessages } from './anthropicMessages.service';
import { cutFrame } from './proxy/sse';
import { anthropicToOpenAI } from '../lib/anthropic';
import { messagesCacheKey, responseCacheKey } from '../lib/responseCache';

// ── Fake Anthropic, answering however the test says ─────────────────────────────────────────────

type Handler = (res: http.ServerResponse) => void;
const seen = { path: '' };
let handler: Handler = () => {};
const open: http.ServerResponse[] = [];

const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const START = ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 1 } } });
const json = (status: number, body: object, headers: Record<string, string> = {}): Handler => (res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const error = (type: string) => ({ type: 'error', error: { type, message: `${type} for organization org-123` }, request_id: 'req_1' });
const MESSAGE = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn',
  usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 42 } };

let upstream: http.Server;
let gateway: FastifyInstance;
let gatewayUrl = '';
let base = '';

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.path = req.url ?? '';
      if (req.url?.endsWith('/chat/completions')) {
        json(200, { id: 'c', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'translated' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })(res);
        return;
      }
      open.push(res);
      handler(res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  gateway = Fastify();
  // A caller with a team key is a tenant; without one, the operator.
  gateway.post('/v1/messages', async (req, reply) => handleAnthropicMessages(req.body as Record<string, unknown>, reply,
    req.headers['x-team'] ? 'tk-1' : undefined, req.headers as Record<string, unknown>));
  gatewayUrl = await gateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await gateway?.close(); upstream?.closeAllConnections(); await new Promise((r) => upstream?.close(r)); });
beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  for (const k of Object.keys(route)) delete route[k];
  Object.assign(route, {
    keyId: 'key-a', decryptedKey: 'sk-ant-provider', keyMask: '●●●●1234', baseUrl: `${base}/v1`,
    modelString: 'claude-sonnet-4-5', modelId: 'm-a', providerSlug: 'anthropic', tier: 'premium',
    authHeader: 'x-api-key', authPrefix: '', extraHeaders: null, wasDowngrade: false, isProbe: false, sticky: false, byok: false,
  });
  handler = json(200, MESSAGE);
  seen.path = '';
});
afterEach(() => { for (const r of open.splice(0)) r.destroy(); });

const BODY = { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const post = (body: object = BODY, headers: Record<string, string> = {}) =>
  fetch(`${gatewayUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const usageRow = () => recordTokenUsage.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

describe('which way a request goes', () => {
  it('translated when routing chose another model, downgraded, or the caller named none', async () => {
    await post({ ...BODY, model: 'claude-opus-4-1' });
    expect(seen.path).toBe('/v1/chat/completions');
    route.wasDowngrade = true;
    await post();
    expect(seen.path).toBe('/v1/chat/completions');
    route.wasDowngrade = false;
    const { model: _model, ...noModel } = BODY;
    await post(noModel);
    expect(seen.path).toBe('/v1/chat/completions');
  });

  it('translated from a pool on a bearer token, unless the pool says it speaks Anthropic\'s API', async () => {
    Object.assign(route, { authHeader: 'Authorization', authPrefix: 'Bearer' });
    await post();
    expect(seen.path).toBe('/v1/chat/completions');
    route.nativeMessages = '{"enabled":true}';
    await post();
    expect(seen.path).toBe('/v1/messages');
  });
});

describe('Anthropic\'s errors and the key that sent the request', () => {
  it.each([
    [400, 'invalid_request_error', null],
    [401, 'authentication_error', 'reportAuthFailure'],
    [403, 'permission_error', null],
    [429, 'rate_limit_error', 'reportRateLimit'],
    [529, 'overloaded_error', 'reportServerFailure'],
  ] as const)('%i %s → %s', async (status, type, reported) => {
    handler = json(status, error(type));
    const res = await post();
    expect(res.status).toBe(status);
    expect(res.headers.get('x-nexus-native')).toBe('anthropic');
    for (const name of ['reportAuthFailure', 'reportRateLimit', 'reportServerFailure'] as const) {
      expect(breaker[name], name).toHaveBeenCalledTimes(name === reported ? 1 : 0);
    }
    expect(breaker.reportSuccess).not.toHaveBeenCalled();
    expect(setStickyKeyId).not.toHaveBeenCalled();
  });

  it('a tenant on a shared key reads the error type, not the provider\'s words; the operator reads both', async () => {
    handler = json(429, error('rate_limit_error'));
    const tenant = await (await post(BODY, { 'x-team': '1' })).json();
    expect(tenant).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' }, request_id: 'req_1' });
    expect(JSON.stringify(tenant)).not.toContain('org-123');
    expect(JSON.stringify(await (await post()).json())).toContain('org-123');
    route.byok = true;
    expect(JSON.stringify(await (await post(BODY, { 'x-team': '1' })).json())).toContain('org-123');
  });

  it('a provider that cannot be reached gets the gateway\'s own error, in Anthropic\'s shape', async () => {
    route.baseUrl = 'http://127.0.0.1:1/v1';
    const res = await post();
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: expect.any(String), message: 'Upstream connection failed.' } });
    expect(breaker.reportServerFailure).toHaveBeenCalledTimes(1);
  });

  it('a provider that never answers times out the same way', async () => {
    handler = () => {};
    const res = await post();
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ type: 'error', error: { message: 'Upstream timed out before responding.' } });
  });
});

describe('a native stream', () => {
  it('that carries Anthropic\'s error event is recorded as failed, not as a success', async () => {
    const failure = ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    handler = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(START + failure); };
    const res = await post({ ...BODY, stream: true });
    expect(await res.text()).toBe(START + failure);
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1));
    expect(usageRow()).toMatchObject({ outcome: 'upstream_error', inputTokens: 2310 });
    expect(breaker.reportServerFailure).toHaveBeenCalledTimes(1);
    expect(breaker.reportSuccess).not.toHaveBeenCalled();
  });

  it('that goes quiet ends with an Anthropic error event', async () => {
    handler = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(START); };
    const res = await post({ ...BODY, stream: true });
    expect(await res.text()).toBe(START + cutFrame('idle', 'anthropic'));
  });

  it('that goes quiet part-way through an event just ends, with no frame spliced into it', async () => {
    const half = 'event: content_block_delta\ndata: {"type":"content_bl';
    handler = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(START + half); };
    const res = await post({ ...BODY, stream: true });
    expect(await res.text()).toBe(START + half);
  });

  it('keeps the cache parts when a later usage figure leaves them out, and records server-tool use', async () => {
    const delta = ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 42, server_tool_use: { web_search_requests: 2 } } });
    handler = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(START + delta + ev('message_stop', { type: 'message_stop' })); };
    await (await post({ ...BODY, stream: true })).text();
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1));
    expect(usageRow()).toMatchObject({ outcome: 'success', inputTokens: 2310, outputTokens: 42, serverToolUse: { web_search_requests: 2 } });
  });
});

describe('budgets and the response cache', () => {
  it('counts the prompt against the key\'s per-minute budget without its cache reads', async () => {
    await (await post()).json();
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1));
    expect(reconcileTpm).toHaveBeenCalledWith('key-a', expect.any(Number), 10 + 300 + 42);
    expect(usageRow()).toMatchObject({ inputTokens: 2310, outputTokens: 42 });
  });

  it('keys a Messages request on what it sent, so two PDFs that translate alike never share an answer', async () => {
    const ask = (data: string) => ({ ...BODY, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, { type: 'text', text: 'Summarise this.' }] }] });
    const [a, b] = [ask('JVBERi0xAAAA'), ask('JVBERi0xBBBB')];
    expect(responseCacheKey(anthropicToOpenAI(a))).toBe(responseCacheKey(anthropicToOpenAI(b)));   // the old key could not tell them apart
    store.set(messagesCacheKey(a), { id: 'c1', created: 1, model: 'claude-sonnet-4-5', provider: 'anthropic', content: 'About A.', finishReason: 'stop', promptTokens: 5, completionTokens: 2 });

    const hit = await post({ ...a, stream: false });
    expect(hit.headers.get('x-nexus-cache')).toBe('hit');
    expect(await hit.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'About A.' }] });
    expect(seen.path).toBe('');

    const miss = await post(b);
    expect(miss.headers.get('x-nexus-cache')).toBeNull();
    expect(seen.path).toBe('/v1/messages');
  });
});
