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
import { AnthropicStreamTranslator, openAIToAnthropic, anthropicErrorBody } from './anthropic';
import { createChunkDecoder } from './chunkDecoder';

type Json = Record<string, unknown>;

// ── Anthropic reply wrapper (Phase 6.2) ───────────────────────────────────────
// handleProxy speaks OpenAI end to end: it writes OpenAI JSON, or pipes OpenAI SSE, to
// a FastifyReply. Rather than fork that battle-tested path, an Anthropic Messages
// request hands it *this* object in place of the real reply. handleProxy writes OpenAI
// exactly as it always does; every write is intercepted and translated to Anthropic on
// the real socket. The core is untouched, so existing OpenAI traffic carries no risk.

interface RawSink {
  writeHead(status: number, headers?: Record<string, string>): void;
  // `Uint8Array` covers Buffer, which extends it. Naming Buffer alone was the type-level half of
  // the bug: the signature described one of the two things the proxy actually writes.
  write(chunk: string | Uint8Array): void;
  end(): void;
}

export interface AnthropicReply {
  /** Cast to FastifyReply for handleProxy; only the intercepted surface is used. */
  reply: FastifyReply;
}

export function createAnthropicReply(real: FastifyReply): AnthropicReply {
  let status = 200;
  const translator = new AnthropicStreamTranslator();
  // The proxy writes a string on some paths and the upstream's raw bytes on others; see
  // `chunkDecoder.ts` for what happens when a wrapper assumes only one of them, which is the bug
  // this line exists to have fixed.
  const decoder = createChunkDecoder();

  const raw: RawSink = {
    // Same SSE headers; the event framing inside is what differs.
    //
    // The head is also where the translator learns which model Nexus routed to. handleProxy
    // writes `X-Nexus-Model` here, before the first chunk, which is the earliest point the
    // model is known — the translator is built before routing has run. The upstream's own
    // name still wins when its chunks carry one; this covers the providers that omit it,
    // where the reply used to name the virtual model and nothing else.
    writeHead(code, headers) {
      const served = headers?.['X-Nexus-Model'];
      if (typeof served === 'string') translator.setModel(served);
      real.raw.writeHead(code, headers);
    },
    write(chunk) { real.raw.write(translator.push(decoder.text(chunk))); },
    end() {
      // Flush whatever the decoder was holding back for a continuation byte that never came, so a
      // stream truncated mid-character still delivers everything that was complete.
      const tail = decoder.flush();
      if (tail) real.raw.write(translator.push(tail));
      real.raw.write(translator.end());
      real.raw.end();
    },
  };

  const wrapper = {
    raw,
    code(c: number) { status = c; return wrapper; },
    header(k: string, v: string) { void real.header(k, v); return wrapper; },
    hijack() { real.hijack(); return wrapper; },

    // Non-streaming completion, or an error object/string, translated to Anthropic.
    send(payload: unknown) {
      if (status >= 400) {
        const message = errorMessage(payload);
        real.code(status).send(anthropicErrorBody(status, message));
        return wrapper;
      }
      if (payload && typeof payload === 'object' && Array.isArray((payload as Json).choices)) {
        real.code(status).send(openAIToAnthropic(payload as Json));
        return wrapper;
      }
      // Anything else on a success status is unexpected; pass it through verbatim.
      real.code(status).send(payload);
      return wrapper;
    },
  };

  return { reply: wrapper as unknown as FastifyReply };
}

/** Pull a human message out of whatever handleProxy passed to an error send(). */
function errorMessage(payload: unknown): string {
  if (typeof payload === 'string') {
    // Upstream error bodies are often an OpenAI error JSON string; surface its message.
    try {
      const parsed = JSON.parse(payload) as Json;
      const err = parsed.error as Json | string | undefined;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
    } catch { /* not JSON — use as-is */ }
    return payload || 'Upstream error';
  }
  if (payload && typeof payload === 'object') {
    const err = (payload as Json).error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof (err as Json).message === 'string') return String((err as Json).message);
  }
  return 'Request failed';
}
