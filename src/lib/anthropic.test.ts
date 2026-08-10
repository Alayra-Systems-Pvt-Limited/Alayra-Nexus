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
import {
  anthropicToOpenAI, openAIToAnthropic, mapStopReason, anthropicErrorBody,
  anthropicErrorType, AnthropicStreamTranslator, CANONICAL_MODEL,
} from './anthropic';

/** Parse an Anthropic SSE string into [{event, data}] for assertions. */
function parseSse(s: string): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of s.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const dt = block.match(/^data: (.+)$/m)?.[1];
    if (ev && dt) out.push({ event: ev, data: JSON.parse(dt) });
  }
  return out;
}
const oaiChunk = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}\n\n`;

describe('anthropicToOpenAI — request', () => {
  it('lifts a string system prompt into a leading system message', () => {
    const out = anthropicToOpenAI({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
    expect(out.messages).toEqual([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
  });

  it('flattens a block-array system prompt', () => {
    const out = anthropicToOpenAI({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] });
    expect((out.messages as unknown[])[0]).toEqual({ role: 'system', content: 'ab' });
  });

  // This used to assert the opposite — that the requested model was overwritten with the
  // canonical id — which is why an Anthropic-SDK caller could never reach a specific model
  // however it was configured. Carrying the value through is the whole point: resolution
  // happens once, downstream, for every endpoint (see modelCatalog.service).
  it('carries the requested model through to the OpenAI body', () => {
    expect(anthropicToOpenAI({ model: 'claude-opus-4-8', messages: [] }).model).toBe('claude-opus-4-8');
  });

  it('falls back to the auto-route model when the client sent none', () => {
    expect(anthropicToOpenAI({ messages: [] }).model).toBe(CANONICAL_MODEL);
    expect(anthropicToOpenAI({ model: '   ', messages: [] }).model).toBe(CANONICAL_MODEL);
  });

  it('carries generation params and maps stop_sequences → stop', () => {
    const out = anthropicToOpenAI({ messages: [], max_tokens: 5, temperature: 0.2, top_p: 0.9, stop_sequences: ['X'] });
    expect(out).toMatchObject({ max_tokens: 5, temperature: 0.2, top_p: 0.9, stop: ['X'] });
  });

  it('sets stream only when requested', () => {
    expect(anthropicToOpenAI({ messages: [], stream: true }).stream).toBe(true);
    expect(anthropicToOpenAI({ messages: [] }).stream).toBe(false);
  });

  it('translates tools and tool_choice', () => {
    const out = anthropicToOpenAI({
      messages: [],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }]);
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('maps a tool_result block to an OpenAI tool message', () => {
    const out = anthropicToOpenAI({ messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '72F' }] },
    ] });
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 'tu_1', content: '72F' }]);
  });

  it('maps an assistant tool_use block to tool_calls', () => {
    const out = anthropicToOpenAI({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } }] },
    ] });
    const m = (out.messages as Record<string, unknown>[])[0];
    expect(m.role).toBe('assistant');
    expect((m.tool_calls as Record<string, unknown>[])[0]).toMatchObject({
      id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    });
  });

  it('maps a base64 image block to an image_url part', () => {
    const out = anthropicToOpenAI({ messages: [
      { role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
    ] });
    const parts = (out.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });
});

describe('mapStopReason', () => {
  it.each([
    ['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use'],
    ['content_filter', 'end_turn'], [undefined, 'end_turn'], ['weird', 'end_turn'],
  ] as const)('%s → %s', (finish, expected) => {
    expect(mapStopReason(finish)).toBe(expected);
  });
});

describe('openAIToAnthropic — non-streaming response', () => {
  it('translates a text completion with usage', () => {
    const out = openAIToAnthropic({
      id: 'chatcmpl-1', model: 'gpt', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(out).toMatchObject({
      id: 'chatcmpl-1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });

  it('translates tool calls into tool_use blocks with parsed input', () => {
    const out = openAIToAnthropic({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
      ] }, finish_reason: 'tool_calls' }],
    });
    expect(out.stop_reason).toBe('tool_use');
    expect((out.content as Record<string, unknown>[])[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } });
  });

  it('never returns empty content — emits an empty text block', () => {
    const out = openAIToAnthropic({ choices: [{ message: { role: 'assistant' }, finish_reason: 'stop' }] });
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('tolerates malformed tool arguments rather than throwing', () => {
    const out = openAIToAnthropic({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'not json' } }] }, finish_reason: 'tool_calls' }] });
    expect((out.content as Record<string, unknown>[])[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});

describe('anthropic errors', () => {
  it('maps status codes to Anthropic error types', () => {
    expect(anthropicErrorType(400)).toBe('invalid_request_error');
    expect(anthropicErrorType(401)).toBe('authentication_error');
    expect(anthropicErrorType(429)).toBe('rate_limit_error');
    expect(anthropicErrorType(503)).toBe('api_error');
  });
  it('builds the error envelope', () => {
    expect(anthropicErrorBody(429, 'slow down')).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  });
});

describe('AnthropicStreamTranslator — text', () => {
  it('emits the full Anthropic event flow for a text stream', () => {
    const t = new AnthropicStreamTranslator();
    let sse = '';
    sse += t.push(oaiChunk({ model: 'gpt', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }));
    sse += t.push(oaiChunk({ choices: [{ delta: { content: 'lo' } }] }));
    sse += t.push(oaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    sse += t.push('data: [DONE]\n\n');
    sse += t.end();

    const events = parseSse(sse);
    expect(events.map(e => e.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    // text is delivered incrementally
    expect((events[2].data.delta as Record<string, unknown>).text).toBe('Hel');
    expect((events[3].data.delta as Record<string, unknown>).text).toBe('lo');
    // stop reason carried on message_delta
    expect((events[5].data.delta as Record<string, unknown>).stop_reason).toBe('end_turn');
    // message_start announces an assistant message with the model
    expect((events[0].data.message as Record<string, unknown>).role).toBe('assistant');
  });

  // Routing happens after the translator is constructed, so the model that actually served
  // the request is named later, from the response head.
  describe('setModel', () => {
    it('names the routed model in message_start', () => {
      const t = new AnthropicStreamTranslator();
      t.setModel('claude-sonnet-4-5');
      const sse = t.push(oaiChunk({ choices: [{ delta: { content: 'hi' } }] }));
      const start = parseSse(sse).find(e => e.event === 'message_start');
      expect((start!.data.message as Record<string, unknown>).model).toBe('claude-sonnet-4-5');
    });

    it('yields to the model the upstream names in its own chunk', () => {
      // The provider's answer is the accurate one — it knows the dated variant it actually
      // ran. This is only a fallback for providers that omit `model` from their SSE.
      const t = new AnthropicStreamTranslator();
      t.setModel('gpt-4o');
      const sse = t.push(oaiChunk({ model: 'gpt-4o-2024-08-06', choices: [{ delta: { content: 'hi' } }] }));
      const start = parseSse(sse).find(e => e.event === 'message_start');
      expect((start!.data.message as Record<string, unknown>).model).toBe('gpt-4o-2024-08-06');
    });

    it('ignores an empty model rather than blanking the name', () => {
      const t = new AnthropicStreamTranslator();
      t.setModel('');
      const sse = t.push(oaiChunk({ choices: [{ delta: { content: 'hi' } }] }));
      const start = parseSse(sse).find(e => e.event === 'message_start');
      expect((start!.data.message as Record<string, unknown>).model).toBe(CANONICAL_MODEL);
    });
  });

  it('buffers a partial SSE line split across two pushes', () => {
    const t = new AnthropicStreamTranslator();
    const chunk = oaiChunk({ choices: [{ delta: { content: 'hi' } }] });
    const mid = Math.floor(chunk.length / 2);
    let sse = t.push(chunk.slice(0, mid));   // first half — no complete line yet
    sse += t.push(chunk.slice(mid));         // completes the line
    const deltas = parseSse(sse).filter(e => e.event === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0].data.delta as Record<string, unknown>).text).toBe('hi');
  });

  it('maps length finish_reason to max_tokens', () => {
    const t = new AnthropicStreamTranslator();
    t.push(oaiChunk({ choices: [{ delta: { content: 'x' } }] }));
    t.push(oaiChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }));
    const events = parseSse(t.end());
    const md = events.find(e => e.event === 'message_delta');
    expect((md!.data.delta as Record<string, unknown>).stop_reason).toBe('max_tokens');
  });

  it('produces a well-formed envelope for an empty stream', () => {
    const t = new AnthropicStreamTranslator();
    const events = parseSse(t.end());
    expect(events.map(e => e.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
  });
});

describe('AnthropicStreamTranslator — tools', () => {
  it('opens a tool_use block and streams input_json_delta, closing any text first', () => {
    const t = new AnthropicStreamTranslator();
    let sse = '';
    sse += t.push(oaiChunk({ choices: [{ delta: { content: 'let me check' } }] }));
    sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }));
    sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] } }] }));
    sse += t.push(oaiChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    sse += t.end();

    const events = parseSse(sse);
    const names = events.map(e => e.event);
    // text block opens, then closes when the tool call begins, then the tool block opens
    expect(names).toEqual([
      'message_start', 'content_block_start', 'content_block_delta',   // text
      'content_block_stop',                                             // text closed
      'content_block_start', 'content_block_delta', 'content_block_delta', // tool_use + json deltas
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const toolStart = events.find(e => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'tool_use');
    expect((toolStart!.data.content_block as Record<string, unknown>)).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    const jsonDeltas = events.filter(e => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'input_json_delta');
    expect(jsonDeltas.map(d => (d.data.delta as Record<string, unknown>).partial_json).join('')).toBe('{"city":"SF"}');
    expect((events.find(e => e.event === 'message_delta')!.data.delta as Record<string, unknown>).stop_reason).toBe('tool_use');
  });
});
