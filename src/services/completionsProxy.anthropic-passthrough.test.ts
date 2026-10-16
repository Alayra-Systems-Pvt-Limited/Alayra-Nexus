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

// The native Anthropic passthrough, end to end over real sockets: a Fastify gateway serving
// /v1/messages exactly as routes/proxy.ts does (without its API-key check, so no database), and a
// fake Anthropic on loopback that records what reached it. No network.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { schemalessFastify } from '../../test/schemalessFastify';

vi.mock('./cache.service', () => ({ getCacheConfig: vi.fn(async () => ({ enabled: true, ttlSeconds: 60 })) }));
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
vi.mock('./token.service', () => ({ recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...(a as [])), recordOutcome: vi.fn(async () => {}) }));
const reportServerFailure = vi.fn(async () => {});
const route: Record<string, unknown> = {};
vi.mock('./nexus.service', () => ({
  discoverBestPool: vi.fn(async () => route),
  getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess: vi.fn(async () => {}), reportServerFailure: (...a: unknown[]) => reportServerFailure(...(a as [])),
  reportRateLimit: vi.fn(async () => {}), reportAuthFailure: vi.fn(async () => {}), reportTierExhausted: vi.fn(async () => {}),
}));
vi.mock('../lib/sticky',    () => ({ sessionHash: () => 'session-1', setStickyKeyId: vi.fn(async () => {}) }));
vi.mock('../lib/admission', () => ({ reconcileTpm: vi.fn(async () => {}) }));
vi.mock('../lib/safeFetch', () => ({ safeFetch: (url: string, init: RequestInit) => fetch(url, init) }));
// Every model name routes automatically here; which provider serves it is the route above.
vi.mock('./modelCatalog.service', async (o) => ({
  ...(await o<typeof import('./modelCatalog.service')>()),
  resolveRequestedModel: vi.fn(async () => ({ kind: 'auto' })),
}));
// The routed model prices web search, so the request's search tool may go to Anthropic.
vi.mock('./model.service', () => ({ getModelRegistry: vi.fn(async () => [{ id: 'm-a', modelString: 'claude-sonnet-4-5', webSearchCostPer1K: 10 }]) }));

import { handleAnthropicMessages } from './anthropicMessages.service';
import { handleProxy } from './completionsProxy.service';
import { countTokens } from '../lib/tokenizer';

// ── Fake Anthropic ──────────────────────────────────────────────────────────────────────────────

const USAGE = {
  input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 42,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, server_tool_use: { web_search_requests: 1 },
};
const MESSAGE = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE };
const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const START = ev('message_start', { type: 'message_start', message: { ...MESSAGE, content: [], usage: { ...USAGE, output_tokens: 1 } } });
const STREAM = [
  START,
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi.' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
  ev('message_stop', { type: 'message_stop' }),
];
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };

const seen = { path: '', headers: {} as http.IncomingHttpHeaders, body: '' };
const fake = { mode: 'json' as 'json' | 'stream' | 'overloaded' | 'endless', closedAt: 0, finished: false, sent: '' };

function serveAnthropic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c.toString(); });
  req.on('end', () => {
    Object.assign(seen, { path: req.url ?? '', headers: req.headers, body: raw });
    if (req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'translated' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      return;
    }
    if (fake.mode === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(MESSAGE)); return; }
    if (fake.mode === 'overloaded') {
      res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '3', 'request-id': 'req_529', 'anthropic-organization-id': 'org-1' });
      res.end(JSON.stringify(OVERLOADED));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (fake.mode === 'stream') { fake.finished = true; res.end(STREAM.join('')); return; }
    res.write(START);                                   // endless: one word every 10ms until closed
    let i = 0;
    const timer = setInterval(() => {
      const frame = ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `w${i++} ` } });
      fake.sent += frame; res.write(frame);
    }, 10);
    res.on('close', () => { clearInterval(timer); fake.closedAt = Date.now(); });
  });
}

// ── The gateway ─────────────────────────────────────────────────────────────────────────────────

let upstream: http.Server;
let gateway: FastifyInstance;
let gatewayUrl = '';
let base = '';

const ANTHROPIC = () => ({
  keyId: 'key-a', decryptedKey: 'sk-ant-provider', keyMask: '●●●●1234', baseUrl: `${base}/v1`,
  modelString: 'claude-sonnet-4-5', modelId: 'm-a', providerSlug: 'anthropic', tier: 'premium',
  authHeader: 'x-api-key', authPrefix: '', extraHeaders: '{"anthropic-version":"2023-06-01"}',
  wasDowngrade: false, isProbe: false, sticky: false, byok: false,
});

beforeAll(async () => {
  upstream = http.createServer(serveAnthropic);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  gateway = schemalessFastify();
  gateway.post('/v1/messages', async (req, reply) =>
    handleAnthropicMessages(req.body as Record<string, unknown>, reply, undefined, req.headers as Record<string, unknown>));
  gateway.post('/v1/chat/completions', async (req, reply) => handleProxy(req.body as never, reply));
  gatewayUrl = await gateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await gateway?.close(); await new Promise((r) => upstream?.close(r)); });
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(route)) delete route[k];
  Object.assign(route, ANTHROPIC());
  Object.assign(fake, { mode: 'json', closedAt: 0, finished: false, sent: '' });
  Object.assign(seen, { path: '', headers: {}, body: '' });
});

const post = (body: object, headers: Record<string, string> = {}, path = '/v1/messages') =>
  fetch(`${gatewayUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const usageRow = () => recordTokenUsage.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

// Everything the translated path drops: cache_control, thinking, a PDF, top_k, a server tool.
const RICH = {
  model: 'claude-sonnet-4-5', max_tokens: 1024, top_k: 5,
  thinking: { type: 'enabled', budget_tokens: 2048 },
  system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
  messages: [{ role: 'user', content: [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Summarise it.' },
  ] }],
};

describe('a /v1/messages request routed to Anthropic', () => {
  it('reaches Anthropic\'s own /messages with the body as sent, and its answer comes back untouched', async () => {
    const res = await post(RICH);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nexus-native')).toBe('anthropic');
    expect(await res.json()).toEqual(MESSAGE);
    expect(seen.path).toBe('/v1/messages');
    expect(JSON.parse(seen.body)).toEqual(RICH);
  });

  it('strips what Nexus cannot price, names it in X-Nexus-Stripped, and still answers', async () => {
    const res = await post({ ...RICH, speed: 'fast', context_management: { edits: [] }, some_future_field: { on: true },
      tools: [...RICH.tools, { type: 'code_execution_20250825', name: 'code_execution' }] }, { 'anthropic-beta': 'fast-mode-2026-02-01' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nexus-stripped'))
      .toBe('speed, context_management, some_future_field, tool:code_execution_20250825, anthropic-beta:fast-mode-2026-02-01');
    expect(JSON.parse(seen.body)).toEqual(RICH);
    expect(seen.headers['anthropic-beta']).toBeUndefined();
  });

  it('lets a field through when the pool allows it', async () => {
    route.nativeMessages = '{"allow":["speed","context_management"]}';
    const body = { ...RICH, speed: 'fast', context_management: { edits: [] } };
    const res = await post(body, { 'anthropic-beta': 'fast-mode-2026-02-01' });
    expect(res.headers.get('x-nexus-stripped')).toBeNull();
    expect(JSON.parse(seen.body)).toEqual(body);
    expect(seen.headers['anthropic-beta']).toBe('fast-mode-2026-02-01');
  });


  it('sends the key\'s own credential and the version and beta headers, and nothing else of the caller\'s', async () => {
    route.extraHeaders = '{"Anthropic-Version":"2023-01-01","anthropic-beta":"context-1m-2025-08-07"}';
    await post(RICH, {
      'x-api-key': 'nexus-caller-key', authorization: 'Bearer nexus-caller-key', cookie: 'a=b', 'x-custom': '1',
      'anthropic-version': '2023-06-01', 'anthropic-beta': 'extended-cache-ttl-2025-04-11',
    });
    expect(seen.headers['x-api-key']).toBe('sk-ant-provider');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers['anthropic-beta']).toBe('context-1m-2025-08-07,extended-cache-ttl-2025-04-11');
    for (const h of ['authorization', 'cookie', 'x-custom']) expect(seen.headers[h], h).toBeUndefined();
  });

  it('sends the pool\'s version when the caller names none, and the default when neither does', async () => {
    route.extraHeaders = '{"anthropic-version":"2023-01-01"}';
    await post(RICH);
    expect(seen.headers['anthropic-version']).toBe('2023-01-01');
    route.extraHeaders = null;
    await post(RICH);
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('records the whole prompt as input, with the cache reads and writes beside it, and the searches run', async () => {
    await post(RICH);
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1));
    expect(usageRow()).toMatchObject({
      provider: 'anthropic', inputTokens: 2310, outputTokens: 42,
      detail: { cachedInputTokens: 2000, cacheWriteTokens: 300, cacheWrite5mTokens: 100, cacheWrite1hTokens: 200 },
      serverToolUse: { web_search_requests: 1 },
    });
    expect(setCached).not.toHaveBeenCalled();             // a native answer is never cached
  });

  it('streams Anthropic\'s events through byte for byte, and records the same usage', async () => {
    fake.mode = 'stream';
    const res = await post({ ...RICH, stream: true });
    expect(res.headers.get('x-nexus-native')).toBe('anthropic');
    expect(await res.text()).toBe(STREAM.join(''));
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1));
    expect(usageRow()).toMatchObject({ outcome: 'success', inputTokens: 2310, outputTokens: 42, detail: { cachedInputTokens: 2000, cacheWrite1hTokens: 200 } });
    expect(setCached).not.toHaveBeenCalled();
  });

  it('passes Anthropic\'s own error through, marked native, with its retry headers', async () => {
    fake.mode = 'overloaded';
    const res = await post({ ...RICH, speed: 'fast' });
    expect(res.status).toBe(529);
    expect(await res.json()).toEqual(OVERLOADED);
    expect(res.headers.get('x-nexus-native')).toBe('anthropic');
    expect(res.headers.get('x-nexus-stripped')).toBe('speed');
    expect(res.headers.get('retry-after')).toBe('3');
    expect(res.headers.get('request-id')).toBe('req_529');
    expect(res.headers.get('anthropic-organization-id')).toBeNull();
    expect(reportServerFailure).toHaveBeenCalledWith('key-a', false);
  });

  it('stops Anthropic when the caller hangs up, and bills the prompt and what was streamed', async () => {
    fake.mode = 'endless';
    const received = await new Promise<string>((resolve) => {
      let got = '';
      const req = http.request(`${gatewayUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      req.on('response', (res) => res.on('data', (c: Buffer) => {
        got += c.toString();
        if (got.split('content_block_delta').length > 6) { req.destroy(); resolve(got); }
      }));
      req.on('error', () => {});
      req.end(JSON.stringify({ ...RICH, stream: true }));
    });
    const hungUpAt = Date.now();
    await vi.waitFor(() => expect(recordTokenUsage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(fake.closedAt, 'the provider socket never closed').toBeGreaterThan(0);
    expect(fake.closedAt - hungUpAt).toBeLessThan(1_000);
    const row = usageRow();
    expect(row).toMatchObject({ outcome: 'client_cancelled', inputTokens: 2310, detail: { cachedInputTokens: 2000 } });
    expect(row.outputTokens).toBeGreaterThan(1);
    expect(row.outputTokens).toBeLessThanOrEqual(countTokens(fake.sent.split('"text":"').slice(1).map((s) => s.split('"')[0]).join('')));
    expect(received).toContain('event: message_start');
    expect(reportServerFailure).not.toHaveBeenCalled();
  });
});

describe('everything else keeps the translated path', () => {
  it('a request routed to another provider is translated, with no native header', async () => {
    Object.assign(route, { providerSlug: 'openai', modelString: 'gpt-4o', authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null });
    const res = await post(RICH);
    expect(res.headers.get('x-nexus-native')).toBeNull();
    expect(seen.path).toBe('/v1/chat/completions');
    expect(await res.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'translated' }] });
  });

  it('an OpenAI-format request keeps its prompt_cache_key', async () => {
    Object.assign(route, { providerSlug: 'openai', modelString: 'gpt-4o', authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null });
    await post({ messages: [{ role: 'user', content: 'hi' }], prompt_cache_key: 'conv-42' }, {}, '/v1/chat/completions');
    expect(JSON.parse(seen.body).prompt_cache_key).toBe('conv-42');
  });
});
