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

import { describe, it, expect } from 'vitest';
import { goesNative, nativeRequest, pickNativeHeaders, sentWholeToday } from './anthropicNative';
import type { NexusRoute } from '../nexus.service';
import type { GuardedRequest } from './inputGuard';
import type { AnthropicNative } from './types';

const route = (over: Partial<NexusRoute> = {}) => ({
  keyId: 'k', decryptedKey: 'sk-ant-provider', keyMask: 'm', baseUrl: 'https://api.anthropic.com/v1/', modelString: 'claude-sonnet-4-5',
  modelId: null, providerSlug: 'anthropic', tier: 'premium', authHeader: 'x-api-key', authPrefix: '',
  extraHeaders: '{"Anthropic-Version":"2023-01-01","x-operator":"on"}', wasDowngrade: false, isProbe: false, sticky: false, byok: false,
  ...over,
}) as NexusRoute;
const native = (body: Record<string, unknown>, headers: Record<string, string> = {}): AnthropicNative => ({ body, headers, passThrough: () => {} });
const messages = [{ role: 'user', content: 'hi' }];
const guarded = (over: Partial<GuardedRequest> = {}): GuardedRequest => ({
  guard: { enabled: false, bufferedSafe: false, compiled: [] } as unknown as GuardedRequest['guard'],
  guardHeaders: {}, effectiveMessages: messages, outputFiltering: false, bufferStream: false, ...over,
});

describe('pickNativeHeaders', () => {
  it('takes the version and beta headers only, joining a repeated beta header', () => {
    expect(pickNativeHeaders({
      'anthropic-version': '2023-06-01', 'anthropic-beta': ['a-2025', 'b-2025'],
      'x-api-key': 'nexus-key', authorization: 'Bearer nexus-key', cookie: 'c',
    })).toEqual({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'a-2025,b-2025' });
    expect(pickNativeHeaders({})).toEqual({});
  });
});

describe('nativeRequest', () => {
  it('goes to <base>/messages with the route\'s credential, the caller\'s version over the configured one', () => {
    const r = nativeRequest(native({ model: 'claude-sonnet-4-5', max_tokens: 5 }, { 'anthropic-version': '2023-06-01' }), route());
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers).toEqual({
      'x-operator': 'on', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'x-api-key': 'sk-ant-provider',
    });
  });

  it('keeps the configured version when the caller sends none, and the body object itself when the model matches', () => {
    const body = { model: 'claude-sonnet-4-5', max_tokens: 5 };
    const r = nativeRequest(native(body), route());
    expect(r.headers['Anthropic-Version']).toBe('2023-01-01');
    expect(r.body).toBe(body);
    expect(nativeRequest(native({ ...body, model: 'alias' }), route()).body).toEqual(body);
  });
});

describe('goesNative', () => {
  const body = { model: 'x', messages };
  const on = { enabled: true, bufferedSafe: false, compiled: [{ name: 'r' }] } as unknown as GuardedRequest['guard'];

  it('only for a Messages request routed to Anthropic', () => {
    expect(goesNative(native(body), route(), guarded(), messages)).toBe(true);
    expect(goesNative(undefined, route(), guarded(), messages)).toBe(false);
    expect(goesNative(native(body), route({ providerSlug: 'openrouter' }), guarded(), messages)).toBe(false);
  });

  it('not when the guardrails redacted the prompt or will read the answer', () => {
    expect(goesNative(native(body), route(), guarded({ effectiveMessages: [{ role: 'user', content: '[REDACTED]' }] }), messages)).toBe(false);
    expect(goesNative(native(body), route(), guarded({ outputFiltering: true }), messages)).toBe(false);
  });

  it('with guardrails on, only when every part is scanned or already sent unscanned today', () => {
    expect(goesNative(native(body), route(), guarded({ guard: on }), messages)).toBe(true);
    const pdf = { model: 'x', messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] };
    expect(goesNative(native(pdf), route(), guarded({ guard: on }), messages)).toBe(false);
    expect(goesNative(native(pdf), route(), guarded(), messages)).toBe(true);
  });
});

describe('sentWholeToday', () => {
  const user = (...content: unknown[]) => ({ messages: [{ role: 'user', content }] });
  it.each([
    ['a string prompt', { system: 'Be brief.', messages }, true],
    ['text, tool calls and images', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: '1', name: 'f', input: {} }] }, { role: 'user', content: [{ type: 'image', source: {} }] }] }, true],
    ['a tool result of text', user({ type: 'tool_result', content: 'ok' }, { type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }), true],
    ['system text blocks', { system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }], messages }, true],
    ['a document', user({ type: 'document', source: {} }), false],
    ['thinking', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }] }, false],
    ['redacted thinking', { messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }] }, false],
    ['a server tool block', { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: '1', name: 'web_search', input: {} }] }] }, false],
    ['a tool result holding an image', user({ type: 'tool_result', content: [{ type: 'image', source: {} }] }), false],
    ['an unknown block', user({ type: 'brand_new' }), false],
    ['a system block that is not text', { system: [{ type: 'image' }], messages }, false],
    ['a block that is not an object', user('loose string'), false],
  ])('%s → %s', (_name, body, expected) => {
    expect(sentWholeToday(body as Record<string, unknown>)).toBe(expected);
  });
});
