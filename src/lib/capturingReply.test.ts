/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The stand-in reply the Playground hands to `handleProxy`.
//
// Every test here calls it the way the proxy does — the same methods, in the same order, with the
// same chunk types — rather than the way a stand-in is convenient to call. That distinction is not
// pedantic: the Anthropic wrapper's tests all wrote strings while the proxy writes bytes, which is
// how a complete, correctly framed, empty response shipped.

import { describe, it, expect, vi } from 'vitest';
import { createCapturingReply } from './capturingReply';

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);

describe('a non-streaming response', () => {
  it('keeps the status, the headers and the payload', () => {
    const { reply, captured } = createCapturingReply();

    // Exactly the shape of the proxy's success exit: headers looped on, then code().send().
    reply.header('X-Nexus-Model', 'mock-model-1');
    reply.header('X-Nexus-Provider', 'custom');
    reply.code(200).send({ choices: [{ message: { content: 'hi' } }] });

    expect(captured.status).toBe(200);
    expect(captured.headers['x-nexus-model']).toBe('mock-model-1');
    expect(captured.payload).toEqual({ choices: [{ message: { content: 'hi' } }] });
    expect(captured.streamed).toBe(false);
    expect(captured.ended).toBe(true);
  });

  it('keeps a refusal, including one built by chaining', () => {
    // `code().header().send()` — the budget and no-capacity exits both chain like this, so a
    // `header()` that failed to return the wrapper would break them and only them.
    const { reply, captured } = createCapturingReply();
    reply.code(429).header('Retry-After', '30').send({ error: 'Team budget exhausted' });

    expect(captured.status).toBe(429);
    expect(captured.headers['retry-after']).toBe('30');
    expect(captured.payload).toMatchObject({ error: 'Team budget exhausted' });
  });

  it('keeps an upstream error body, which arrives as a string not an object', () => {
    // `reply.code(upstream.status).send(errText)` forwards the provider's own body verbatim. A
    // capture that assumed an object would hand the Playground `undefined` for exactly the case a
    // user most needs to read.
    const { reply, captured } = createCapturingReply();
    reply.code(401).send('{"error":{"message":"invalid api key"}}');

    expect(captured.status).toBe(401);
    expect(typeof captured.payload).toBe('string');
    expect(captured.payload).toContain('invalid api key');
  });

  it('lowercases header names whichever way they arrived', () => {
    // One path writes headers through `header()`, the other through `writeHead()`. A caller looking
    // for the model should not have to know which served it.
    const viaHeader = createCapturingReply();
    viaHeader.reply.header('X-Nexus-Cache', 'hit');
    viaHeader.reply.code(200).send({});

    const viaHead = createCapturingReply();
    viaHead.reply.hijack();
    viaHead.reply.raw.writeHead(200, { 'X-Nexus-Cache': 'hit' });
    viaHead.reply.raw.end();

    expect(viaHeader.captured.headers['x-nexus-cache']).toBe('hit');
    expect(viaHead.captured.headers['x-nexus-cache']).toBe('hit');
  });
});

describe('a streamed response', () => {
  /** Drive the wrapper exactly as `handleProxy`'s streaming path does. */
  function streamThrough(chunks: (string | Uint8Array)[], opts = {}) {
    const { reply, captured } = createCapturingReply(opts);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Nexus-Model': 'mock-model-1',
    });
    for (const c of chunks) reply.raw.write(c);
    reply.raw.end();
    return captured;
  }

  it('collects the bytes the proxy really writes', () => {
    // Not strings. `reply.raw.write(value)` passes the `Uint8Array` straight off the upstream
    // reader, and a wrapper that called `.toString()` on it would collect "100,97,116,97,…".
    const captured = streamThrough([
      bytes(sse({ choices: [{ delta: { content: 'Hello' } }] })),
      bytes(sse({ choices: [{ delta: { content: ' world' } }] })),
      bytes('data: [DONE]\n\n'),
    ]);

    expect(captured.streamed).toBe(true);
    expect(captured.ended).toBe(true);
    expect(captured.sse).toContain('Hello');
    expect(captured.sse).toContain(' world');
    expect(captured.sse).toContain('[DONE]');
    expect(captured.sse).not.toMatch(/\d+,\d+,\d+/);
    expect(captured.payload).toBeUndefined();
  });

  it('keeps a multi-byte character split across two writes intact', () => {
    const whole = bytes(sse({ choices: [{ delta: { content: 'hi 👋' } }] }));
    const cut   = whole.length - 4;   // mid-emoji
    const captured = streamThrough([whole.slice(0, cut), whole.slice(cut)]);

    expect(captured.sse).toContain('👋');
    expect(captured.sse).not.toContain('�');
  });

  it('still takes strings, which the cache and guardrail paths write', () => {
    const captured = streamThrough([sse({ choices: [{ delta: { content: 'from cache' } }] })]);
    expect(captured.sse).toContain('from cache');
  });

  it('relays each chunk as it arrives, before the stream has ended', () => {
    // What lets the Playground show tokens appearing rather than a pause and then everything. The
    // assertion is that chunks arrive during the stream, not that they exist afterwards.
    const seen: string[] = [];
    const { reply } = createCapturingReply({ onChunk: (c) => seen.push(c) });
    reply.hijack();
    reply.raw.writeHead(200, {});
    reply.raw.write(bytes('data: one\n\n'));
    expect(seen).toHaveLength(1);
    reply.raw.write(bytes('data: two\n\n'));
    expect(seen).toHaveLength(2);
    reply.raw.end();

    expect(seen[0]).toBe('data: one\n\n');
    expect(seen[1]).toBe('data: two\n\n');
  });

  it('marks a stream that outran its retention rather than passing off a prefix as the whole', () => {
    // A cut-off answer presented as the complete one is worse than no answer: it is wrong in a way
    // that reads as right.
    const captured = streamThrough([bytes('x'.repeat(50)), bytes('y'.repeat(50))], { maxSseChars: 60 });

    expect(captured.sse).toHaveLength(60);
    expect(captured.truncated).toBe(true);
  });

  it('does not claim truncation for a stream that fitted', () => {
    const captured = streamThrough([bytes('short')], { maxSseChars: 60 });
    expect(captured.truncated).toBe(false);
  });

  it('still relays everything to onChunk after retention is full', () => {
    // The cap protects the gateway's memory. Capping what the browser is shown as well would turn
    // a memory guard into a truncated answer for the user.
    const seen: string[] = [];
    streamThrough([bytes('a'.repeat(100))], { maxSseChars: 10, onChunk: (c: string) => seen.push(c) });
    expect(seen.join('')).toHaveLength(100);
  });
});

describe('what it deliberately does not do', () => {
  it('survives hijack, which has no socket to take', () => {
    const { reply, captured } = createCapturingReply();
    expect(() => reply.hijack()).not.toThrow();
    expect(captured.streamed).toBe(false);   // committing to a stream is the head, not the hijack
  });

  it('reports not-ended while the proxy is still mid-flight', () => {
    // Distinguishing "finished" from "abandoned" is the only way a caller can tell a completed
    // request from one whose handler threw before answering.
    const { reply, captured } = createCapturingReply();
    reply.hijack();
    reply.raw.writeHead(200, {});
    reply.raw.write('data: partial\n\n');

    expect(captured.streamed).toBe(true);
    expect(captured.ended).toBe(false);
  });

  it('does not call onChunk for a non-streaming response', () => {
    const onChunk = vi.fn();
    const { reply } = createCapturingReply({ onChunk });
    reply.code(200).send({ choices: [] });
    expect(onChunk).not.toHaveBeenCalled();
  });
});
