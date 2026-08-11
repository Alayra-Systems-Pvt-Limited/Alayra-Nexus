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
      // A real socket takes either; decode rather than `.toString()` so this stand-in cannot hide
      // the very bug the tests below are about.
      write(s: string | Uint8Array) { state.raw += typeof s === 'string' ? s : new TextDecoder().decode(s); },
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

    // What the cache-hit and guardrail-buffered paths do: one pre-built SSE string.
    // The ordinary streaming path writes bytes instead — covered below.
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

// ── The bytes the proxy really writes ─────────────────────────────────────────
//
// `completionsProxy.service.ts` reads the upstream body with `getReader()` and writes each chunk
// through unchanged. Those chunks are plain `Uint8Array` — not Buffer, not string. The wrapper used
// to call `.toString()` on them, which for a Uint8Array returns the byte values as a comma
// separated list. The translator then found no SSE events in it and emitted a complete, correctly
// framed, entirely EMPTY Anthropic response: no error, no warning, a blank reply in Claude Code.
//
// Every test above writes a string, because the two paths that write strings — cache hit and
// guardrail buffering — are the two that were reached for. The path carrying ordinary streaming
// traffic was the one nothing exercised.
describe('createAnthropicReply — the chunk type the proxy actually writes', () => {
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const bytes = (s: string) => new TextEncoder().encode(s);

  function streamed(chunks: Uint8Array[]) {
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.hijack();
    wrap.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const c of chunks) wrap.raw.write(c);
    wrap.raw.end();
    return parseSse(state.raw);
  }

  const textOf = (events: ReturnType<typeof streamed>) =>
    events.filter(e => e.event === 'content_block_delta')
          .map(e => (e.data.delta as Record<string, unknown>).text).join('');

  it('delivers the content when chunks arrive as Uint8Array', () => {
    const events = streamed([
      bytes(sse({ model: 'gpt', choices: [{ delta: { role: 'assistant', content: 'Hello' } }] })),
      bytes(sse({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] })),
      bytes('data: [DONE]\n\n'),
    ]);
    expect(textOf(events)).toBe('Hello world');
  });

  it('does not answer with a well-formed empty message', () => {
    // The regression as it actually presented. Framing alone proves nothing: the broken version
    // produced every one of these events too. What it could not produce was a delta.
    const events = streamed([bytes(sse({ choices: [{ delta: { content: 'Hi' } }] }))]);
    expect(events.map(e => e.event)).toContain('content_block_delta');
    expect(textOf(events)).not.toBe('');
  });

  it('keeps a multi-byte character split across two chunks intact', () => {
    // A 4-byte emoji landing on a chunk boundary. Decoding each chunk independently turns it into
    // replacement characters — which is why the decoder is held across writes rather than made per
    // chunk. Real streams split wherever the socket does, so this is ordinary, not exotic.
    const whole = bytes(sse({ choices: [{ delta: { content: 'hi 👋' } }] }));
    const cut   = whole.length - 4;   // mid-emoji
    const events = streamed([whole.slice(0, cut), whole.slice(cut)]);
    expect(textOf(events)).toBe('hi 👋');
    expect(textOf(events)).not.toContain('�');
  });

  it('still accepts strings, which two paths rely on', () => {
    // The cache-hit and guardrail-buffered paths hand over a string. Fixing the byte path must not
    // cost them.
    const { reply, state } = fakeReply();
    const { reply: wrap } = createAnthropicReply(reply);
    wrap.hijack();
    wrap.raw.writeHead(200, {});
    wrap.raw.write(sse({ choices: [{ delta: { content: 'from cache' } }] }));
    wrap.raw.end();
    expect(textOf(parseSse(state.raw))).toBe('from cache');
  });
});
