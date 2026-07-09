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

import { getEncoding, type Tiktoken } from 'js-tiktoken';

// A single shared encoder, lazily initialized. cl100k_base is a reasonable,
// provider-neutral proxy for admission *estimates* — this number is only used to
// reserve budget before a request goes out, not for billing (real usage from the
// provider reconciles it afterward), so it does not need to match each provider's
// exact tokenizer.
let enc: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc;
}

/** Token count of a single string, with a safe character-based fallback. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/** Extract the textual content from a chat message's `content` (string or parts array). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Estimate the input tokens of an OpenAI-style messages array. Adds a small
 * per-message overhead to approximate the chat format's role/delimiter tokens.
 */
export function countMessageTokens(messages: unknown[]): number {
  let total = 0;
  for (const m of messages) {
    if (m && typeof m === 'object' && 'content' in m) {
      total += countTokens(extractText((m as { content: unknown }).content));
      total += 4; // approximate per-message formatting overhead
    }
  }
  return Math.max(1, total);
}

/**
 * Tokens to reserve for one request: estimated input + the (bounded) output the
 * caller allows via `max_tokens`. When `max_tokens` is absent, a default output
 * reserve is used; reconciliation later corrects the reservation to actuals.
 */
export function computeReserve(messages: unknown[], maxTokens: number | undefined, defaultMaxTokens: number): number {
  const input = countMessageTokens(messages);
  const output = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : defaultMaxTokens;
  return input + output;
}
