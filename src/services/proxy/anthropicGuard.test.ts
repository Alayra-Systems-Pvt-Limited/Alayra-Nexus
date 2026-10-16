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
import { referencesOrgFiles, sentWholeToday } from './anthropicGuard';

const messages = [{ role: 'user', content: 'hi' }];
const user = (...content: unknown[]) => ({ messages: [{ role: 'user', content }] });
const b64 = { type: 'base64', media_type: 'image/png', data: 'iVBO' };

describe('sentWholeToday', () => {
  it.each([
    ['a string prompt', { model: 'm', max_tokens: 5, system: 'Be brief.', messages }, true],
    ['text, tool calls and images', { messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: '1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'image', source: b64 }, { type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
    ] }, true],
    ['a tool result of text', user({ type: 'tool_result', tool_use_id: '1', content: 'ok' }, { type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }), true],
    ['system text blocks with a cache marker', { system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }], messages }, true],
    ['settings with no content of their own', { messages, top_k: 5, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, metadata: { user_id: 'u' } }, true],
    ['a custom tool', { messages, tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } }, true],
    ['a document', user({ type: 'document', source: b64 }), false],
    ['thinking', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }] }, false],
    ['redacted thinking', { messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }] }, false],
    ['a server tool block', { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: '1', name: 'web_search', input: {} }] }] }, false],
    ['a tool result holding an image', user({ type: 'tool_result', content: [{ type: 'image', source: b64 }] }), false],
    ['an unknown block', user({ type: 'brand_new' }), false],
    ['a system block that is not text', { system: [{ type: 'image' }], messages }, false],
    ['a block that is not an object', user('loose string'), false],
    ['an image held as a file', user({ type: 'image', source: { type: 'file', file_id: 'file_1' } }), false],
    ['an image source with an unknown field', user({ type: 'image', source: { ...b64, extra: 'x' } }), false],
    ['text carrying citations', user({ type: 'text', text: 'a', citations: [{ cited_text: 'secret' }] }), false],
    ['a field added to a message', { messages: [{ role: 'user', content: 'hi', name: 'x' }] }, false],
    ['a server tool at the top level', { messages, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }, false],
    ['a custom tool with examples', { messages, tools: [{ name: 'f', input_schema: {}, input_examples: [{ q: 'secret' }] }] }, false],
    ['a structured-output schema', { messages, output_config: { format: { type: 'json_schema', schema: {} } } }, false],
    ['a top-level field the translated path never sends', { messages, container: 'c' }, false],
    ['messages that are not an array', { messages: { role: 'user', content: 'hi' } }, false],
    ['no messages at all', { model: 'm' }, false],
  ])('%s → %s', (_name, body, expected) => {
    expect(sentWholeToday(body as Record<string, unknown>)).toBe(expected);
  });
});

describe('referencesOrgFiles', () => {
  it.each([
    ['an image held as a file', user({ type: 'image', source: { type: 'file', file_id: 'f' } }), true],
    ['a document held as a file', user({ type: 'document', source: { type: 'file', file_id: 'f' } }), true],
    ['a container upload', user({ type: 'container_upload', file_id: 'f' }), true],
    ['a file inside a tool result', user({ type: 'tool_result', content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }), true],
    ['a file inside a content document', user({ type: 'document', source: { type: 'content', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }] } }), true],
    ['inline data', user({ type: 'image', source: b64 }, { type: 'text', text: 'hi' }), false],
    ['a string prompt', { messages }, false],
  ])('%s → %s', (_name, body, expected) => {
    expect(referencesOrgFiles(body as Record<string, unknown>)).toBe(expected);
  });
});
