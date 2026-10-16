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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getModelRegistry = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('../model.service', () => ({ getModelRegistry: () => getModelRegistry() }));

import { nativeHeaders, pickNativeHeaders, planNative, poolSpeaksNative, servesRequestedModel } from './anthropicNative';
import { readNativePolicy } from './anthropicPolicy';
import type { NexusRoute } from '../nexus.service';
import type { GuardedRequest } from './inputGuard';
import type { AnthropicNative } from './types';

const route = (over: Partial<NexusRoute> = {}) => ({
  keyId: 'k', decryptedKey: 'sk-ant-provider', keyMask: 'm', baseUrl: 'https://api.anthropic.com/v1/', modelString: 'claude-sonnet-4-5',
  modelId: 'm-1', providerSlug: 'anthropic', tier: 'premium', authHeader: 'x-api-key', authPrefix: '',
  extraHeaders: '{"Anthropic-Version":"2023-01-01","x-operator":"on"}', wasDowngrade: false, isProbe: false, sticky: false, byok: false,
  ...over,
}) as NexusRoute;
const native = (body: Record<string, unknown>, headers: Record<string, string> = {}): AnthropicNative => ({ body, headers, passThrough: () => {} });
const messages = [{ role: 'user', content: 'hi' }];
const guarded = (over: Partial<GuardedRequest> = {}): GuardedRequest => ({
  guard: { enabled: false, bufferedSafe: false, compiled: [] } as unknown as GuardedRequest['guard'],
  guardHeaders: {}, effectiveMessages: messages, outputFiltering: false, bufferStream: false, ...over,
});
const on = { enabled: true, bufferedSafe: false, compiled: [{ name: 'r' }] } as unknown as GuardedRequest['guard'];
const body = { model: 'claude-sonnet-4-5', max_tokens: 5, messages };
const noPolicy = readNativePolicy(null);

beforeEach(() => { getModelRegistry.mockReset(); getModelRegistry.mockResolvedValue([]); });

describe('pickNativeHeaders', () => {
  it('takes the version and beta headers only, joining a repeated beta header', () => {
    expect(pickNativeHeaders({
      'anthropic-version': '2023-06-01', 'anthropic-beta': ['a-2025', 'b-2025'],
      'x-api-key': 'nexus-key', authorization: 'Bearer nexus-key', cookie: 'c',
    })).toEqual({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'a-2025,b-2025' });
    expect(pickNativeHeaders({})).toEqual({});
  });
});

describe('nativeHeaders', () => {
  it('sends the route\'s credential, and the caller\'s version over the configured one whatever its case', () => {
    const { headers } = nativeHeaders({ 'anthropic-version': '2023-06-01' }, route(), noPolicy);
    expect(headers).toEqual({
      'x-operator': 'on', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'x-api-key': 'sk-ant-provider',
    });
  });

  it('falls back to the pool\'s version, then to the default', () => {
    expect(nativeHeaders({}, route(), noPolicy).headers['anthropic-version']).toBe('2023-01-01');
    expect(nativeHeaders({}, route({ extraHeaders: null }), noPolicy).headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends the pool\'s betas and the caller\'s together, never an auth-changing one', () => {
    const r = route({ extraHeaders: '{"anthropic-beta":"context-1m-2025-08-07, oauth-2025-04-20"}' });
    const out = nativeHeaders({ 'anthropic-beta': 'extended-cache-ttl-2025-04-11,oauth-2025-04-20,context-1m-2025-08-07' }, r, noPolicy);
    expect(out.headers['anthropic-beta']).toBe('context-1m-2025-08-07,extended-cache-ttl-2025-04-11');
    expect(out.stripped).toEqual(['anthropic-beta:oauth-2025-04-20', 'anthropic-beta:oauth-2025-04-20']);
  });

  it('drops a caller\'s beta for a feature the pool does not allow, and keeps it when allowed', () => {
    const caller = { 'anthropic-beta': 'fast-mode-2026-02-01,advisor-tool-2026-03-01' };
    expect(nativeHeaders(caller, route(), noPolicy)).toMatchObject({
      stripped: ['anthropic-beta:fast-mode-2026-02-01', 'anthropic-beta:advisor-tool-2026-03-01'],
    });
    expect(nativeHeaders(caller, route(), noPolicy).headers['anthropic-beta']).toBeUndefined();
    const allowed = nativeHeaders(caller, route(), readNativePolicy('{"allow":["speed"]}'));
    expect(allowed.headers['anthropic-beta']).toBe('fast-mode-2026-02-01');
  });
});

describe('when a request goes native', () => {
  it('only from a pool set up for Anthropic\'s own API, or told to', () => {
    expect(poolSpeaksNative(route({ authHeader: 'X-Api-Key' }), noPolicy)).toBe(true);
    expect(poolSpeaksNative(route({ authHeader: 'Authorization', authPrefix: 'Bearer' }), noPolicy)).toBe(false);
    expect(poolSpeaksNative(route({ authHeader: 'Authorization' }), readNativePolicy('{"enabled":true}'))).toBe(true);
    expect(poolSpeaksNative(route(), readNativePolicy('{"enabled":false}'))).toBe(false);
  });

  it('only when routing chose the model the caller asked for, and not as a downgrade', () => {
    expect(servesRequestedModel('Claude-Sonnet-4-5 ', route())).toBe(true);
    expect(servesRequestedModel('claude-opus-4-1', route())).toBe(false);
    expect(servesRequestedModel(undefined, route())).toBe(false);
    expect(servesRequestedModel('claude-sonnet-4-5', route({ wasDowngrade: true }))).toBe(false);
  });

  it('plans <base>/messages for a Messages request routed to Anthropic, and nothing else', async () => {
    const plan = await planNative(native(body), route(), guarded(), messages);
    expect(plan).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', body, stripped: [] });
    expect(await planNative(undefined, route(), guarded(), messages)).toBeNull();
    expect(await planNative(native(body), route({ providerSlug: 'openrouter' }), guarded(), messages)).toBeNull();
    expect(await planNative(native({ ...body, model: 'claude-latest' }), route(), guarded(), messages)).toBeNull();
  });

  it('not when the guardrails redacted the prompt or will read the answer', async () => {
    expect(await planNative(native(body), route(), guarded({ effectiveMessages: [{ role: 'user', content: '[REDACTED]' }] }), messages)).toBeNull();
    expect(await planNative(native(body), route(), guarded({ outputFiltering: true }), messages)).toBeNull();
  });

  it('with guardrails on, only when every part is scanned or already sent unscanned today', async () => {
    expect(await planNative(native(body), route(), guarded({ guard: on }), messages)).not.toBeNull();
    const pdf = { ...body, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'x' } }] }] };
    expect(await planNative(native(pdf), route(), guarded({ guard: on }), messages)).toBeNull();
    expect(await planNative(native(pdf), route(), guarded(), messages)).not.toBeNull();
  });

  it('not on a shared key for a file the key\'s organisation holds; a team\'s own key may', async () => {
    const file = { ...body, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }] }] };
    expect(await planNative(native(file), route(), guarded(), messages)).toBeNull();
    expect(await planNative(native(file), route({ byok: true }), guarded(), messages)).not.toBeNull();
  });
});

describe('what a native request carries', () => {
  it('strips what Nexus cannot price, and names it', async () => {
    const plan = await planNative(native({ ...body, speed: 'fast', service_tier: 'auto', fallbacks: [{}] }), route(), guarded(), messages);
    expect(plan?.body).toEqual(body);
    expect(plan?.stripped).toEqual(['speed', 'service_tier', 'fallbacks']);
  });

  it('keeps a server tool only when the routed model prices it, read from the registry', async () => {
    const tools = [{ type: 'web_search_20260209', name: 'web_search' }, { name: 'mine', input_schema: {} }];
    let plan = await planNative(native({ ...body, tools }), route(), guarded(), messages);
    expect(plan?.body.tools).toEqual([tools[1]]);
    expect(plan?.stripped).toEqual(['tool:web_search_20260209']);

    getModelRegistry.mockResolvedValue([{ id: 'm-1', modelString: 'claude-sonnet-4-5', webSearchCostPer1K: 10 }]);
    plan = await planNative(native({ ...body, tools }), route(), guarded(), messages);
    expect(plan?.body.tools).toEqual(tools);
  });

  it('strips the tool when the registry cannot be read, rather than run it unrecorded', async () => {
    getModelRegistry.mockRejectedValue(new Error('down'));
    const plan = await planNative(native({ ...body, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }), route(), guarded(), messages);
    expect(plan?.body.tools).toBeUndefined();
  });

  it('reads the registry only when the body declares a server tool', async () => {
    await planNative(native({ ...body, tools: [{ type: 'bash_20250124', name: 'bash' }] }), route(), guarded(), messages);
    expect(getModelRegistry).not.toHaveBeenCalled();
  });
});
