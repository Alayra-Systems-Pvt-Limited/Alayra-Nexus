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
import type { FastifyReply } from 'fastify';
import { createAnthropicReply } from './anthropicReply';

// A stand-in FastifyReply that records what the wrapper forwards to the real socket —
// exactly the calls handleProxy makes on a reply.
function fakeReply() {
  const state = { status: 200, sent: undefined as unknown, headers: {} as Record<string, string>, raw: '', ended: false, head: null as unknown };
  const reply = {
    code(c: number) { state.status = c; return reply; },
    header(k: string, v: string) { state.headers[k] = v; return reply; },
    send(b: unknown) { state.sent = b; return reply; },
    hijack() { return reply; },
    raw: {
      writeHead(status: number, headers?: Record<string, string>) { state.head = { status, headers }; },
      write(s: string | Buffer) { state.raw += s.toString(); },
      end() { state.ended = true; },
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function parseSse(s: string) {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of s.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const dt = block.match(/^data: (.+)$/m)?.[1];
    if (ev && dt) out.push({ event: ev, data: JSON.parse(dt) });
  }
  return out;
}

describe('createAnthropicReply — non-streaming', () => {
  it('translates an OpenAI completion into an Anthropic message', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);

    wrap.code(200).send({
      id: 'chatcmpl-9', model: 'gpt',
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    expect(state.sent).toMatchObject({
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }], stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it('translates a Nexus error object into an Anthropic error envelope', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.code(429).send({ error: 'Team budget exhausted', retryAfter: 30 });
    expect(state.status).toBe(429);
    expect(state.sent).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'Team budget exhausted' } });
  });

  it('extracts the message from an upstream OpenAI error string', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.code(502).send(JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }));
    expect(state.sent).toEqual({ type: 'error', error: { type: 'api_error', message: 'upstream boom' } });
  });
});

describe('createAnthropicReply — streaming', () => {
  it('translates a piped OpenAI SSE stream into Anthropic events on the socket', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);

    // Exactly what handleProxy's streaming path does.
    wrap.hijack();
    wrap.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    wrap.raw.write(`data: ${JSON.stringify({ model: 'gpt', choices: [{ delta: { role: 'assistant', content: 'Hi' } }] })}\n\n`);
    wrap.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] })}\n\n`);
    wrap.raw.write('data: [DONE]\n\n');
    wrap.raw.end();

    expect(state.ended).toBe(true);
    const events = parseSse(state.raw);
    expect(events.map(e => e.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const text = events.filter(e => e.event === 'content_block_delta').map(e => (e.data.delta as Record<string, unknown>).text).join('');
    expect(text).toBe('Hi!');
  });

  it('forwards the SSE headers verbatim', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.hijack();
    wrap.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Nexus-Model': 'alayra-nexus-1' });
    wrap.raw.end();
    expect(state.head).toMatchObject({ status: 200, headers: { 'X-Nexus-Model': 'alayra-nexus-1' } });
  });

  // When a provider omits `model` from its SSE chunks, a streamed reply used to report
  // `alayra-nexus-1` — telling a client that pinned a real model nothing about what served
  // it. Routing runs after the translator is built, so the model arrives with the head.
  it('reports the routed model when the upstream chunks do not name one', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.hijack();
    wrap.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Nexus-Model': 'claude-sonnet-4-5' });
    wrap.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
    wrap.raw.end();

    const start = parseSse(state.raw).find(e => e.event === 'message_start');
    expect((start!.data.message as Record<string, unknown>).model).toBe('claude-sonnet-4-5');
  });

  it('still names the auto-route model when no header said otherwise', () => {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.hijack();
    wrap.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    wrap.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
    wrap.raw.end();

    const start = parseSse(state.raw).find(e => e.event === 'message_start');
    expect((start!.data.message as Record<string, unknown>).model).toBe('alayra-nexus-1');
  });
});
