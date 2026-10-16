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

// With input guardrails on, an Anthropic-bound /v1/messages request goes native only when every part
// of it is either scanned (text, tool-result text) or already forwarded unscanned by the translated
// path (tool calls, images). Anything the translated path would have dropped keeps it translated, so
// turning the passthrough on never lets out something the guardrails were trusted to hold back.
// Real sockets on loopback, as in the passthrough test beside this one; no network.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { compileRules, type GuardrailRule } from '../lib/guardrails';

const guard = { enabled: true, bufferedSafe: false, compiled: [] as ReturnType<typeof compileRules> };
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => guard) }));
vi.mock('./cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 60 })) }));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));
vi.mock('./token.service',      () => ({ recordTokenUsage: vi.fn(async () => {}), recordOutcome: vi.fn(async () => {}) }));
const route: Record<string, unknown> = {};
vi.mock('./nexus.service', () => ({
  discoverBestPool: vi.fn(async () => route), getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess: vi.fn(async () => {}), reportServerFailure: vi.fn(async () => {}),
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

import { handleAnthropicMessages } from './anthropicMessages.service';

/** Each request the fake provider received: which endpoint, and the body as it arrived. */
const calls: Array<{ path: string; body: string }> = [];

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c.toString(); });
  req.on('end', () => {
    calls.push({ path: req.url ?? '', body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.endsWith('/chat/completions')
      ? { id: 'c', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }
      : { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
  });
}

let upstream: http.Server;
let gateway: FastifyInstance;
let gatewayUrl = '';
let base = '';

beforeAll(async () => {
  upstream = http.createServer(serve);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  gateway = Fastify();
  gateway.post('/v1/messages', async (req, reply) =>
    handleAnthropicMessages(req.body as Record<string, unknown>, reply, undefined, req.headers as Record<string, unknown>));
  gatewayUrl = await gateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await gateway?.close(); await new Promise((r) => upstream?.close(r)); });

const BLOCK_SECRET: GuardrailRule = { name: 'no-secret', pattern: 'project-zebra', action: 'block', appliesTo: 'input' };
beforeEach(() => {
  calls.length = 0;
  guard.enabled = true;
  guard.compiled = compileRules([BLOCK_SECRET]);
  Object.assign(route, {
    keyId: 'key-a', decryptedKey: 'sk-ant-provider', keyMask: '●●●●1234', baseUrl: `${base}/v1`,
    modelString: 'claude-sonnet-4-5', modelId: 'm-a', providerSlug: 'anthropic', tier: 'premium',
    authHeader: 'x-api-key', authPrefix: '', extraHeaders: null,
    wasDowngrade: false, isProbe: false, sticky: false, byok: false,
  });
});

const ask = (...messages: object[]) =>
  fetch(`${gatewayUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, system: 'Be brief.', messages }),
  });
const user = (...content: object[]) => ({ role: 'user', content });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = { role: 'assistant', content: [text('Looking.'), { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }] };
const toolResult = (content: unknown) => ({ type: 'tool_result', tool_use_id: 'tu_1', content });
const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } };
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } };

/** Which way the request went: 'native', 'translated', or the status when nothing reached the provider. */
async function wayOf(res: Response): Promise<string | number> {
  await res.arrayBuffer();
  if (calls.length === 0) return res.status;
  const native = res.headers.get('x-nexus-native') === 'anthropic';
  expect(calls[0].path).toBe(native ? '/v1/messages' : '/v1/chat/completions');
  return native ? 'native' : 'translated';
}

describe('with input guardrails on', () => {
  it('text only goes native, and is still scanned', async () => {
    expect(await wayOf(await ask(user(text('Hello there.'))))).toBe('native');
    calls.length = 0;
    expect(await wayOf(await ask(user(text('Tell me about project-zebra.'))))).toBe(400);
  });

  it('a system prompt that matches a rule is blocked too', async () => {
    const res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 64, system: [text('Codename project-zebra.')], messages: [user(text('hi'))] }),
    });
    expect(await wayOf(res)).toBe(400);
  });

  it('tool calls and text tool results go native, and the result text is scanned', async () => {
    expect(await wayOf(await ask(user(text('Read a.txt')), toolUse, user(toolResult('plain text'), text('go on'))))).toBe('native');
    expect(await wayOf(await ask(user(text('Read a.txt')), toolUse, user(toolResult([text('more text')]))))).toBe('native');
    calls.length = 0;
    expect(await wayOf(await ask(user(text('Read a.txt')), toolUse, user(toolResult('the file says project-zebra'))))).toBe(400);
  });

  it('an image goes native: the translated path forwards it unscanned today too', async () => {
    expect(await wayOf(await ask(user(image, text('What is this?'))))).toBe('native');
  });

  it('a PDF keeps the translated path, with no native header', async () => {
    const res = await ask(user(pdf, text('Summarise.')));
    expect(res.headers.get('x-nexus-native')).toBeNull();
    expect(await wayOf(res)).toBe('translated');
    expect(calls[0].body).not.toContain('JVBERi0x');      // dropped, exactly as before
  });

  it('a tool result holding an image keeps the translated path', async () => {
    expect(await wayOf(await ask(user(text('Shot?')), toolUse, user(toolResult([text('see'), image]))))).toBe('translated');
  });

  it('a thinking block keeps the translated path', async () => {
    const thinking = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think.', signature: 'sig' }, text('Done.')] };
    expect(await wayOf(await ask(user(text('Q')), thinking, user(text('And?'))))).toBe('translated');
  });

  it('a block type nobody knows yet keeps the translated path', async () => {
    expect(await wayOf(await ask(user({ type: 'brand_new_block', payload: 'x' }, text('hi'))))).toBe('translated');
  });

  it('a redacted prompt goes translated, so the redacted form is what leaves', async () => {
    guard.compiled = compileRules([{ name: 'mask', pattern: 'project-zebra', action: 'redact', appliesTo: 'input' }]);
    expect(await wayOf(await ask(user(text('About project-zebra.'))))).toBe('translated');
    expect(calls[0].body).not.toContain('project-zebra');
  });

  it('output rules keep the translated path, where they can read the answer', async () => {
    guard.compiled = compileRules([{ name: 'out', pattern: 'nothing-matches-this', action: 'block', appliesTo: 'output' }]);
    expect(await wayOf(await ask(user(text('hi'))))).toBe('translated');
  });
});

describe('with guardrails off', () => {
  it('a PDF goes native', async () => {
    guard.enabled = false;
    expect(await wayOf(await ask(user(pdf, text('Summarise.'))))).toBe('native');
    expect(calls[0].body).toContain('JVBERi0x');
  });
});
