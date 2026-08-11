/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Three lines of production code, tested at length, because this is where a shipped P0 lived: a
// wrapper that assumed the proxy only ever wrote strings answered every streaming Anthropic request
// with a complete, correctly framed, empty message.
//
// Two wrappers depend on this now. If it is ever wrong again it will be wrong in both at once,
// which is the cost of sharing it — and the reason the guarantees are spelled out here rather than
// left to each caller to rediscover.

import { describe, it, expect } from 'vitest';
import { createChunkDecoder } from './chunkDecoder';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('what arrives as text', () => {
  it('passes a string through untouched', () => {
    // The cache-hit and guardrail-buffered paths write pre-built SSE strings. Decoding them would
    // be a round trip with nothing to gain and an encoding to get wrong.
    const d = createChunkDecoder();
    expect(d.text('data: already text\n\n')).toBe('data: already text\n\n');
  });

  it('decodes bytes rather than listing them', () => {
    // `Uint8Array.prototype.toString()` returns "100,97,116,97,…" and throws nothing. The whole
    // bug in one assertion.
    const d = createChunkDecoder();
    const out = d.text(bytes('data: hello\n\n'));
    expect(out).toBe('data: hello\n\n');
    expect(out).not.toMatch(/^\d+,\d+/);
  });

  it('decodes a Buffer, which is a Uint8Array wearing a hat', () => {
    // Buffer would have worked under the old `.toString()` too. That near-miss is most of why the
    // bug read as correct code, so it is worth pinning that both still work.
    const d = createChunkDecoder();
    expect(d.text(Buffer.from('data: hello\n\n', 'utf8'))).toBe('data: hello\n\n');
  });
});

describe('characters split across chunks', () => {
  it('holds an incomplete character until the chunk that finishes it', () => {
    const whole = bytes('hi 👋');
    const cut   = whole.length - 2;   // mid-emoji: two of its four bytes in each chunk
    const d = createChunkDecoder();

    const first = d.text(whole.slice(0, cut));
    const second = d.text(whole.slice(cut));

    expect(first + second).toBe('hi 👋');
    expect(first + second).not.toContain('�');
  });

  it('is what a fresh decoder per chunk fails to do', () => {
    // The contrast is the point. This is the behaviour of the obvious implementation, and it does
    // not throw — it produces plausible-looking text with the character replaced.
    const whole = bytes('hi 👋');
    const cut   = whole.length - 2;
    const naive = new TextDecoder().decode(whole.slice(0, cut)) + new TextDecoder().decode(whole.slice(cut));

    expect(naive).toContain('�');
    expect(naive).not.toBe('hi 👋');
  });

  it('survives a character split three ways', () => {
    // A four-byte character can straddle more than one boundary when the network is unkind.
    const whole = bytes('👋');
    const d = createChunkDecoder();
    const out = d.text(whole.slice(0, 1)) + d.text(whole.slice(1, 3)) + d.text(whole.slice(3));
    expect(out).toBe('👋');
  });
});

describe('the end of a stream', () => {
  it('flushes nothing when the stream ended on a character boundary', () => {
    const d = createChunkDecoder();
    d.text(bytes('all complete'));
    expect(d.flush()).toBe('');
  });

  it('surfaces a truncated character rather than dropping it silently', () => {
    // A stream cut mid-character is a real event — an aborted upstream, an idle timeout. Flushing
    // yields the replacement character, which is visible; discarding it would quietly shorten the
    // model's answer with nothing to indicate anything was lost.
    const d = createChunkDecoder();
    const whole = bytes('hi 👋');
    d.text(whole.slice(0, whole.length - 2));
    expect(d.flush()).toBe('�');
  });
});
