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

// ── Turning what the proxy writes into text ───────────────────────────────────
//
// `handleProxy` writes to a reply in two different types, and which one it is depends on which path
// served the request. The cache-hit and guardrail-buffered paths write a string. Ordinary streaming
// writes the `Uint8Array` it read from the upstream body.
//
// Any wrapper standing in for a reply has to accept both, and getting that wrong is not a mild bug.
// `Uint8Array.prototype.toString` is `Array.prototype.toString` — it returns the byte values as a
// comma separated list, `"100,97,116,97,…"` — which downstream is not a decode failure but a string
// containing no SSE events. The Anthropic wrapper did exactly this and answered every streaming
// request with a complete, correctly framed, empty message. No error, nothing logged.
//
// A `Buffer` would have decoded correctly, which is most of why it survived review. So this exists
// as one named thing rather than three lines repeated in each wrapper: the next wrapper gets the
// behaviour by asking for it, and the reasoning is in one place with tests against it.

/** Decodes a stream's chunks as text, remembering what it could not finish. */
export interface ChunkDecoder {
  /** A chunk as text. Strings pass through untouched; bytes are decoded. */
  text(chunk: string | Uint8Array): string;
  /**
   * Whatever was still held back at the end of the stream.
   *
   * Empty for a stream that ended on a character boundary, which is nearly all of them. Non-empty
   * when the last chunk stopped mid-character — a truncated stream, where flushing delivers the
   * replacement character rather than silently dropping the partial sequence.
   */
  flush(): string;
}

export function createChunkDecoder(): ChunkDecoder {
  // ONE decoder for the whole stream, not one per chunk. A multi-byte character can be split across
  // two socket writes — ordinary, since a stream splits wherever the network splits it — and a
  // decoder that forgets the tail between calls turns a single emoji into replacement characters.
  // `stream: true` is what makes it hold the incomplete tail until the next chunk completes it.
  const decoder = new TextDecoder();
  return {
    text: (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })),
    flush: () => decoder.decode(),
  };
}
