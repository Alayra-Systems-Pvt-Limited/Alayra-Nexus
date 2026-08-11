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

import type { FastifyReply } from 'fastify';
import { createChunkDecoder } from './chunkDecoder';

// ── Capturing reply (Playground) ──────────────────────────────────────────────
//
// `handleProxy` is the request path. `/v1/chat/completions` is a three line wrapper over it, and
// `/v1/messages` is another that translates the shape on the way out. There is no second router,
// and the Playground must not become one: a playground that proves a *different* code path works
// proves nothing anybody cares about.
//
// So the Playground is a third wrapper, and this is what makes that possible. `handleProxy` writes
// its answer to a `FastifyReply`; the Playground needs that answer as a value it can put beside a
// `RequestTrace` in one JSON object. This object accepts every call `handleProxy` makes on a reply
// and keeps the result instead of writing it to a socket.
//
// The precedent is `createAnthropicReply`, which stands in for a reply and translates. This one
// stands in for a reply and collects. Same seam, different job.
//
// Deliberately NOT a general-purpose reply. It implements the surface `handleProxy` actually uses —
// `code`, `header`, `send`, `hijack`, and `raw.writeHead` / `raw.write` / `raw.end` — and nothing
// else. A wider stand-in would invite a caller to rely on behaviour nothing here guarantees.

/** What the proxy said, once it has finished saying it. */
export interface CapturedResponse {
  status: number;
  /**
   * Header names lowercased, as HTTP/2 requires and as Fastify normalises them. A caller looking
   * for `x-nexus-model` should not have to guess which of the two paths wrote it, since one arrives
   * through `header()` and the other through `writeHead()`.
   */
  headers: Record<string, string>;
  /** True once the proxy took the streaming path — set when it writes a head, not when it hijacks. */
  streamed: boolean;
  /** True once the response was completed. False means the proxy is still mid-flight, or threw. */
  ended: boolean;
  /**
   * The value handed to `send()` on a non-streaming response.
   *
   * Usually an object. Sometimes a string: an upstream error body is forwarded verbatim rather than
   * re-wrapped, so a caller rendering this has to handle both. `undefined` on a streamed response.
   */
  payload: unknown;
  /** The raw SSE text of a streamed response. Empty on a non-streaming one. */
  sse: string;
  /**
   * True when the stream outran `maxSseChars` and what is held here is a prefix.
   *
   * Present because the alternative is a Playground that shows a cut-off answer as though it were
   * the whole one. A truncated reply that says so is a limitation; one that does not is a lie about
   * what the model returned.
   */
  truncated: boolean;
}

export interface CapturingReplyOptions {
  /**
   * Called with each chunk of a streamed response as it arrives, decoded.
   *
   * This is what lets the Playground relay tokens to the browser as the provider produces them
   * while still ending up with the trace. Without it the object simply collects, which is what the
   * tests and the non-streaming path want.
   */
  onChunk?: (chunk: string) => void;
  /**
   * How much of a streamed response to retain, in characters. Default 1,000,000.
   *
   * A cap rather than unbounded growth because an upstream that streams without stopping would
   * otherwise grow a string in the gateway for as long as it kept talking. The idle guard in the
   * proxy bounds the gaps between chunks; nothing bounds the total. Retention is capped; `onChunk`
   * still sees everything, so relaying is unaffected.
   */
  maxSseChars?: number;
}

export interface CapturingReply {
  /** Cast to FastifyReply for handleProxy; only the intercepted surface is used. */
  reply: FastifyReply;
  /** Filled in as the proxy works. Complete once `handleProxy` has resolved. */
  captured: CapturedResponse;
}

const DEFAULT_MAX_SSE_CHARS = 1_000_000;

export function createCapturingReply(opts: CapturingReplyOptions = {}): CapturingReply {
  const maxSseChars = opts.maxSseChars ?? DEFAULT_MAX_SSE_CHARS;
  const decoder = createChunkDecoder();

  const captured: CapturedResponse = {
    status: 200, headers: {}, streamed: false, ended: false,
    payload: undefined, sse: '', truncated: false,
  };

  const collect = (text: string): void => {
    if (!text) return;
    opts.onChunk?.(text);
    const room = maxSseChars - captured.sse.length;
    if (room <= 0) { captured.truncated = true; return; }
    if (text.length > room) { captured.sse += text.slice(0, room); captured.truncated = true; return; }
    captured.sse += text;
  };

  const putHeader = (name: string, value: unknown): void => {
    captured.headers[name.toLowerCase()] = String(value);
  };

  const raw = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status   = status;
      captured.streamed = true;
      for (const [k, v] of Object.entries(headers ?? {})) putHeader(k, v);
    },
    write(chunk: string | Uint8Array) { collect(decoder.text(chunk)); },
    end() {
      collect(decoder.flush());
      captured.ended = true;
    },
  };

  const wrapper = {
    raw,
    code(c: number) { captured.status = c; return wrapper; },
    header(k: string, v: string) { putHeader(k, v); return wrapper; },
    // No socket to take over, so there is nothing to do — but the proxy calls it before every
    // streamed response and a missing method would throw. `streamed` is set by the head that
    // follows, which is the write that actually commits to streaming.
    hijack() { return wrapper; },
    send(payload: unknown) {
      captured.payload = payload;
      captured.ended   = true;
      return wrapper;
    },
  };

  return { reply: wrapper as unknown as FastifyReply, captured };
}
