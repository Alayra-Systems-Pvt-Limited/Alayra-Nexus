/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Reading a stream as it goes is harder than reading it afterwards in exactly one way: nothing
// arrives whole. A frame splits across socket writes, a character splits across a frame boundary,
// and the last line may have no newline after it at all. The version this replaced sidestepped all
// three by holding every byte until the end, which is what it was replaced for.
//
// So most of what is below is boundaries. The parsing tests came from `responseCache.test.ts` with
// the parsing itself, and are kept because they describe the format rather than the buffer.

import { describe, it, expect } from 'vitest';
import { createStreamTally } from './streamTally';

const sse   = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
const delta = (content: string) => sse({ choices: [{ delta: { content } }] });

/** Feed a whole stream in one piece and read it. */
function whole(text: string) {
  const t = createStreamTally();
  t.push(text);
  t.end();
  return t;
}

describe('the answer', () => {
  it('is the delta content, concatenated', () => {
    const t = whole([
      sse({ choices: [{ delta: { role: 'assistant' } }] }),
      delta('Hello'),
      delta(', world'),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join(''));

    expect(t.content()).toBe('Hello, world');
  });

  it('preserves escaping, because it parses JSON rather than reading around it', () => {
    expect(whole(delta('line1\nline2')).content()).toBe('line1\nline2');
    expect(whole(delta('he said "hi"')).content()).toBe('he said "hi"');
    expect(whole(delta('function f() { return 1; }')).content()).toBe('function f() { return 1; }');
    expect(whole(delta('{"nested":"json"}')).content()).toBe('{"nested":"json"}');
  });

  it('ignores the lines that are not frames', () => {
    // Keepalive comments and `event:` lines are ordinary in SSE and carry nothing to bill for.
    const t = whole([': keepalive\n\n', 'event: message\n', delta('x'), '\n\n'].join(''));
    expect(t.content()).toBe('x');
  });

  it('skips a frame that is not JSON instead of losing the stream', () => {
    const t = whole([delta('a'), 'data: not json at all\n\n', delta('b')].join(''));
    expect(t.content()).toBe('ab');
  });

  it('is empty for a stream that only ever carried tool calls', () => {
    // Nothing to cache and nothing to replay — the proxy checks for exactly this before storing.
    const t = whole(sse({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }));
    expect(t.content()).toBe('');
  });
});

describe('what nothing arrives whole', () => {
  it('holds a frame split across two chunks until it is complete', () => {
    const wire = delta('Hello, world');
    const cut  = Math.floor(wire.length / 2);
    const t = createStreamTally();

    t.push(bytes(wire.slice(0, cut)));
    expect(t.content(), 'a half-arrived frame is not an answer yet').toBe('');
    t.push(bytes(wire.slice(cut)));
    t.end();

    expect(t.content()).toBe('Hello, world');
  });

  it('holds a frame split across three chunks', () => {
    const wire = delta('abc');
    const t = createStreamTally();
    t.push(wire.slice(0, 10));
    t.push(wire.slice(10, 20));
    t.push(wire.slice(20));
    t.end();
    expect(t.content()).toBe('abc');
  });

  it('keeps a multi-byte character split across two chunks intact', () => {
    // The chunk decoder's job, exercised through here because this is where it is wired up: a
    // per-chunk decoder yields a replacement character and no error.
    //
    // The cut is found rather than guessed. A first draft used `length - 6`, which lands in the
    // `"}}]}` after the emoji, so the character was never actually split and the test passed
    // against a decoder rebuilt on every chunk — a guard that guards nothing.
    const wire = bytes(delta('hi 👋'));
    const lead = wire.findIndex((b) => b >= 0xf0);      // first byte of the four-byte character
    expect(lead, 'no four-byte character to split').toBeGreaterThan(-1);
    const cut  = lead + 2;                             // two of its four bytes in each chunk
    const t = createStreamTally();
    t.push(wire.slice(0, cut));
    t.push(wire.slice(cut));
    t.end();

    expect(t.content()).toBe('hi 👋');
    expect(t.content()).not.toContain('�');
  });

  it('reads a final frame that arrived without a trailing newline', () => {
    // Ending without one is within spec, and the loop only emits on a newline. Without the flush in
    // `end()` the last token of every such stream would be dropped from the count and the cache.
    const t = createStreamTally();
    t.push(delta('first'));
    t.push('data: {"choices":[{"delta":{"content":"last"}}]}');   // no newline
    t.end();

    expect(t.content()).toBe('firstlast');
  });

  it('takes strings and bytes alike', () => {
    const t = createStreamTally();
    t.push(delta('a'));
    t.push(bytes(delta('b')));
    t.end();
    expect(t.content()).toBe('ab');
  });
});

describe('what it cost', () => {
  it('reads the usage the provider reported', () => {
    const t = whole([
      delta('hi'),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      'data: [DONE]\n\n',
    ].join(''));

    expect(t.usage()).toEqual({ input: 11, output: 7 });
  });

  it('takes the last figure, not the first', () => {
    // Providers that report usage mid-stream are reporting a running total. Billing from the first
    // one bills for the first token of every answer.
    const t = whole([
      sse({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 11, completion_tokens: 1 } }),
      sse({ choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } }),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 9 } }),
    ].join(''));

    expect(t.usage()?.output).toBe(9);
  });

  it('says nothing rather than zero when the provider reported nothing', () => {
    // The distinction the caller depends on: null means "count it yourself", and a 0 here would
    // mean "the provider says this answer was free". OpenAI is the provider that reports nothing.
    expect(whole([delta('a lengthy answer'), 'data: [DONE]\n\n'].join('')).usage()).toBeNull();
  });

  it('ignores the null usage that most frames carry', () => {
    const t = whole([
      sse({ choices: [{ delta: { content: 'a' } }], usage: null }),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ].join(''));

    expect(t.usage()).toEqual({ input: 3, output: 4 });
  });

  it('treats a usage block with no completion count as zero output, not as absent', () => {
    const t = whole(sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 5 } }));
    expect(t.usage()).toEqual({ input: 5, output: 0 });
  });
});

describe('what it refuses to hold', () => {
  it('reports a frame dropped for being implausibly large', () => {
    // An upstream that never sends a newline is the one way this can grow without bound, and
    // growing without bound is what this module was written to stop.
    const t = createStreamTally();
    t.push(`data: {"choices":[{"delta":{"content":"${'x'.repeat(1_100_000)}`);   // never terminated
    t.end();

    expect(t.degraded()).toBe(true);
  });

  it('does not report a hole in a stream that had none', () => {
    // The proxy skips the cache when this is true, so a false positive silently disables caching
    // for every stream.
    const t = whole([delta('x'.repeat(200_000)), 'data: [DONE]\n\n'].join(''));
    expect(t.degraded()).toBe(false);
    expect(t.content()).toHaveLength(200_000);
  });
});

describe('what it keeps, which is the point', () => {
  it('holds the answer rather than the wire it arrived on', () => {
    // The measurement behind #125. Each token is delivered inside a repeated JSON envelope; holding
    // the envelopes is what made a long answer cost megabytes.
    const tokens = Array.from({ length: 2000 }, () => ' word');
    const wire   = tokens.map(delta).join('') + 'data: [DONE]\n\n';

    const t = whole(wire);

    expect(t.content()).toBe(tokens.join(''));
    // Not a precise budget — a ratio this size cannot happen by accident, and a regression to
    // holding the stream would put these two within a few bytes of each other.
    expect(t.content().length * 10).toBeLessThan(wire.length);
  });
});
