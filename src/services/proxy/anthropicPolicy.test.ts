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
import { nativeBetas, readNativePolicy, shapeNativeBody, strippedHeader, toolFamily, type NativePolicy } from './anthropicPolicy';

const policy = (raw: string | null = null): NativePolicy => readNativePolicy(raw);
const unpriced = () => false;
const base = { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] };
const shape = (body: Record<string, unknown>, p = policy(), priced = unpriced, shared = true) =>
  shapeNativeBody({ body, policy: p, priced, shared });

describe('readNativePolicy', () => {
  it('reads the switch and the allow list', () => {
    const p = policy('{"enabled":true,"allow":["speed"," code_execution "]}');
    expect(p.enabled).toBe(true);
    expect([...p.allow]).toEqual(['speed', 'code_execution']);
  });

  it('reads anything malformed as the defaults', () => {
    for (const raw of [null, '', 'not json', '[1]', '{"enabled":"yes","allow":"speed"}', '{"allow":[1,null]}']) {
      const p = policy(raw);
      expect(p.enabled, String(raw)).toBeUndefined();
      expect(p.allow.size, String(raw)).toBe(0);
    }
  });
});

describe('shapeNativeBody: request fields', () => {
  it('keeps every field Anthropic bills as tokens only', () => {
    const body = {
      ...base, system: 's', stream: true, stop_sequences: ['x'], temperature: 0, top_p: 1, top_k: 5, thinking: { type: 'adaptive' },
      metadata: { user_id: 'u' }, cache_control: { type: 'ephemeral' }, output_config: { effort: 'high' }, diagnostics: { previous_message_id: null },
    };
    expect(shape(body)).toEqual({ body, stripped: [] });
  });

  it('strips fields that change the price or the model, and any it does not know', () => {
    const body = { ...base, speed: 'fast', service_tier: 'auto', inference_geo: 'us', fallbacks: [], mcp_servers: [], container: 'c', context_management: {}, brand_new: 1 };
    expect(shape(body)).toEqual({
      body: base,
      stripped: ['speed', 'service_tier', 'inference_geo', 'fallbacks', 'mcp_servers', 'container', 'context_management', 'brand_new'],
    });
  });

  it('lets a field through when the pool allows it, except a container on a shared key', () => {
    const p = policy('{"allow":["speed","container"]}');
    expect(shape({ ...base, speed: 'fast', container: 'c' }, p).body).toEqual({ ...base, speed: 'fast' });
    expect(shape({ ...base, speed: 'fast', container: 'c' }, p, unpriced, false).body).toEqual({ ...base, speed: 'fast', container: 'c' });
  });

  it('never changes the caller\'s own object', () => {
    const body = { ...base, speed: 'fast' };
    shape(body);
    expect(body.speed).toBe('fast');
  });
});

describe('shapeNativeBody: tools', () => {
  const custom = { name: 'lookup', description: 'd', input_schema: { type: 'object' } };
  const client = [{ type: 'bash_20250124', name: 'bash' }, { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
    { type: 'computer_toolset_20260801', name: 'computer' }, { type: 'memory_20250818', name: 'memory' }, { type: 'custom', name: 'c' }];
  const search = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };

  it('keeps custom and client tools', () => {
    const body = { ...base, tools: [custom, ...client] };
    expect(shape(body)).toEqual({ body, stripped: [] });
  });

  it('keeps a server tool the model prices, or the pool allows', () => {
    expect(shape({ ...base, tools: [search] }, policy(), (f) => f === 'web_search').stripped).toEqual([]);
    expect(shape({ ...base, tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }, policy('{"allow":["code_execution"]}')).stripped).toEqual([]);
  });

  it('strips an unpriced server tool, an unknown type too, and a tool_choice that names one', () => {
    const body = { ...base, tools: [custom, search, { type: 'advisor_20260301', name: 'advisor' }, { type: 'brand_new_20270101', name: 'n' }], tool_choice: { type: 'tool', name: 'web_search' } };
    expect(shape(body)).toEqual({
      body: { ...base, tools: [custom] },
      stripped: ['tool:web_search_20260209', 'tool:advisor_20260301', 'tool:brand_new_20270101', 'tool_choice'],
    });
  });

  it('keeps a tool_choice that names a tool still there', () => {
    const body = { ...base, tools: [custom, search], tool_choice: { type: 'tool', name: 'lookup' } };
    expect(shape(body).body).toEqual({ ...base, tools: [custom], tool_choice: { type: 'tool', name: 'lookup' } });
  });

  it('removes tools and any tool_choice once no tool is left', () => {
    expect(shape({ ...base, tools: [search], tool_choice: { type: 'auto' } })).toEqual({ body: base, stripped: ['tool:web_search_20260209', 'tool_choice'] });
  });

  it('names a tool family without its date', () => {
    expect(toolFamily('web_search_20260209')).toBe('web_search');
    expect(toolFamily('tool_search_tool_regex_20251119')).toBe('tool_search_tool_regex');
    expect(toolFamily('mcp_toolset')).toBe('mcp_toolset');
  });
});

describe('nativeBetas', () => {
  it('sends nothing when neither side names a beta', () => {
    expect(nativeBetas(undefined, undefined, policy())).toEqual({ value: undefined, stripped: [] });
  });

  it('keeps the operator\'s own feature betas, and sends a beta both sides name once', () => {
    expect(nativeBetas('fast-mode-2026-02-01', 'fast-mode-2026-02-01, a-1', policy()))
      .toEqual({ value: 'fast-mode-2026-02-01,a-1', stripped: [] });
  });
});

describe('strippedHeader', () => {
  it('lists what was removed, in a value a header can carry', () => {
    expect(strippedHeader([])).toBeUndefined();
    expect(strippedHeader(['speed', 'tool:web_search_20260209'])).toBe('speed, tool:web_search_20260209');
    expect(strippedHeader(['bad\r\nX-Injected: 1', 'é'])).toBe('bad__X-Injected:_1, _');
  });

  it('caps a long list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}`);
    expect(strippedHeader(many)?.endsWith('f31, and 8 more')).toBe(true);
  });
});
