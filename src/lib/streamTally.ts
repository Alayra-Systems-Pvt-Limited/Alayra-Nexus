/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Reading a stream while it goes past ───────────────────────────────────────────────────────
//
// The proxy has to answer two questions about a streamed completion that it is forwarding
// untouched: what did the model say, and what did it cost. Until now it answered both at the end,
// from a string holding every byte the provider sent — which cost 32x more memory than the answer
// it was after, and got the second question wrong.
//
// ── What the buffer cost ──────────────────────────────────────────────────────────────────────
//
// SSE repeats the whole JSON envelope for every token. Delivering the six-byte token `" world"`
// puts 191 bytes on the wire; keeping the wire format keeps all 191. A 64,000-token answer — the
// most a current model will produce — held 11.7 MB. The words themselves are about 366 KB, and the
// words are all anything downstream ever wanted: the cache stores content, the token count counts
// content, and usage is one small object.
//
// So this parses as it goes and keeps only those. Retention becomes proportional to the answer, and
// an answer is already bounded by the model's own output limit — which is why there is no cap here.
// A cap would have to either truncate an answer the operator paid for or refuse to cache it, and
// neither is worth doing to bound something the model already bounds.
//
// ── What the buffer got wrong ─────────────────────────────────────────────────────────────────
//
// Two functions derived the same content from that string by two different methods. One parsed
// each `data:` line as JSON. The other reached into the JSON with a regular expression:
//
//   /"delta"\s*:\s*\{[^}]*"content"\s*:\s*"([^"]*)"/g
//
// which matches up to the content's closing quote and stops one brace short, so `JSON.parse('{' +
// match + '}')` was always unbalanced, always threw, and was always swallowed. It returned nothing
// for every input, including `Hello world`. It was the fallback used whenever a provider did not
// volunteer a usage block — which is OpenAI, on every streamed request, unless asked with
// `stream_options` — so those answers were billed as one output token each.
//
// There is one parse here now, and it is the JSON one. Not because the regex was repairable, but
// because two ways to read one format is the shape the bug came in.

import { createChunkDecoder } from './chunkDecoder';

export interface StreamUsage { input: number; output: number }

export interface StreamTally {
  /** Feed one chunk exactly as it came off the upstream reader — bytes or text, either is fine. */
  push(chunk: string | Uint8Array): void;
  /** No more chunks are coming. Flushes a half-arrived character and a half-arrived line. */
  end(): void;
  /** The assistant's answer, assembled from the content deltas seen so far. */
  content(): string;
  /** The last usage the provider reported, or null if it never reported any. */
  usage(): StreamUsage | null;
  /** True if a frame was dropped for being implausibly large; the content may have a hole. */
  degraded(): boolean;
}

/**
 * A single SSE frame this long is not something any provider sends — one frame carries one token.
 * It is what an upstream that never sends a newline looks like, and holding it would reintroduce
 * the unbounded buffer this module exists to remove.
 */
const MAX_FRAME_CHARS = 1_000_000;

interface Frame {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export function createStreamTally(): StreamTally {
  // One decoder for the whole stream — see `chunkDecoder.ts` for what a fresh one per chunk does to
  // a multi-byte character that arrives in two pieces.
  const decoder = createChunkDecoder();
  /** A line that has not finished arriving. SSE frames split across socket writes routinely. */
  let pending  = '';
  let content  = '';
  let usage: StreamUsage | null = null;
  let dropped  = false;

  const readFrame = (raw: string): void => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;          // comments, `event:`, blank separators
    const json = line.slice(5).trim();
    if (!json || json === '[DONE]') return;

    let frame: Frame;
    try { frame = JSON.parse(json) as Frame; } catch { return; }   // a keepalive, or a truncated tail

    const delta = frame.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') content += delta;

    // Last one wins: providers emit usage in the final frame, and a mid-stream figure is a running
    // total, not the bill.
    const u = frame.usage;
    if (u && typeof u.prompt_tokens === 'number') {
      usage = {
        input:  u.prompt_tokens,
        output: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      };
    }
  };

  const consume = (text: string): void => {
    if (!text) return;
    pending += text;
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      readFrame(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
    if (pending.length > MAX_FRAME_CHARS) { pending = ''; dropped = true; }
  };

  return {
    push:     (chunk) => consume(decoder.text(chunk)),
    content:  () => content,
    usage:    () => usage,
    degraded: () => dropped,
    end() {
      consume(decoder.flush());
      // A stream cut mid-frame leaves a line with no newline. Read it: a provider that ends without
      // a trailing newline is well within spec, and a truncated one simply fails to parse.
      if (pending) { readFrame(pending); pending = ''; }
    },
  };
}
