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

import { countCl100k, loadCl100k } from './bpeCount';
import { estimateTokens, TPM_ESTIMATE } from './tokenEstimate';

export { readTpmEstimate, TPM_ESTIMATE, type TpmEstimate } from './tokenEstimate';

// cl100k_base is a reasonable, provider-neutral proxy for admission *estimates*: this number
// reserves budget before a request goes out, and the provider's real usage reconciles it afterward,
// so it does not need to match each provider's exact tokenizer. It is counted by bpeCount.ts, which
// gives js-tiktoken's exact count in time linear in the text (js-tiktoken's own merge is quadratic
// in the length of one unbroken word, and one long word could stall the event loop for seconds).

/** Token count of a single string, with a safe character-based fallback. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return countCl100k(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Load the tokenizer's ranks in the background, so that no request pays for it: about 0.1-0.3 s,
 * and more from a cold disk. With NEXUS_TPM_ESTIMATE=fast the first exact count can come in the
 * middle of a request (the recount of a refused estimate, or the usage of a provider that reports
 * none). Returns at once; the load runs on the next turn of the event loop. The proxy routes call
 * it once the server is listening, in every worker (routes/proxy.ts).
 */
export function warmTokenizer(): void {
  setImmediate(() => {
    try {
      loadCl100k();
    } catch (err) {
      console.warn('  Tokenizer warm-up failed; it loads on first use instead:', err instanceof Error ? err.message : err);
    }
  }).unref();
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

/** Sum a per-text count over an OpenAI-style messages array, plus 4 per message for the chat format. */
function sumMessages(messages: unknown[], count: (text: string) => number): number {
  let total = 0;
  for (const m of messages) {
    if (m && typeof m === 'object' && 'content' in m) {
      total += count(extractText((m as { content: unknown }).content));
      total += 4; // approximate per-message formatting overhead
    }
  }
  return Math.max(1, total);
}

/**
 * Count the input tokens of an OpenAI-style messages array with the tokenizer. Adds a small
 * per-message overhead to approximate the chat format's role/delimiter tokens.
 *
 * This is the exact count, and it stays exact: usage rows fall back to it when a provider does not
 * report usage, so it must never become an estimate.
 */
export function countMessageTokens(messages: unknown[]): number {
  return sumMessages(messages, countTokens);
}

/** `countMessageTokens`, estimated: the same messages, the same per-message overhead, no tokenizer. */
export function estimateMessageTokens(messages: unknown[]): number {
  return sumMessages(messages, estimateTokens);
}

// ── Which count the reservation uses ─────────────────────────────────────────────────────────────

/**
 * A request's TPM reservation, as routing uses it.
 *
 * With NEXUS_TPM_ESTIMATE=fast it starts as the estimate, which errs high. Routing calls
 * `makeExact()` before it would refuse on it (selectAndReserve): when the estimate is bigger than a
 * candidate key's WHOLE limit, and when a pass over the keys refused the estimate. Either refusal
 * could be the estimate's own margin, and repeat on every retry, although the exact count fits.
 * So a refusal is always decided on the tokenizer's count, and only a refused request pays for
 * it. With the tokenizer (the default) it is exact from the start, and `makeExact()` does nothing.
 */
export interface TokenReserve {
  /** Tokens to reserve: the estimate until `makeExact()` runs, then the tokenizer's count. */
  readonly tokens: number;
  /** True once `tokens` is the tokenizer's count. */
  readonly exact: boolean;
  /** Count with the tokenizer (once) and reserve that from here on. Returns the new `tokens`. */
  makeExact(): number;
}

/** The reservation for one request: its input, counted per NEXUS_TPM_ESTIMATE, plus its output allowance. */
export function planReserve(messages: unknown[], maxTokens: number | undefined, defaultMaxTokens: number): TokenReserve {
  const output = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : defaultMaxTokens;
  if (TPM_ESTIMATE !== 'fast') {
    const tokens = countMessageTokens(messages) + output;
    return { tokens, exact: true, makeExact: () => tokens };
  }
  let tokens = estimateMessageTokens(messages) + output;
  let exact = false;
  return {
    get tokens() { return tokens; },
    get exact() { return exact; },
    makeExact() {
      if (!exact) { tokens = countMessageTokens(messages) + output; exact = true; }
      return tokens;
    },
  };
}

/**
 * Tokens to reserve for one request: estimated input + the (bounded) output the
 * caller allows via `max_tokens`. When `max_tokens` is absent, a default output
 * reserve is used; reconciliation later corrects the reservation to actuals.
 */
export function computeReserve(messages: unknown[], maxTokens: number | undefined, defaultMaxTokens: number): number {
  return planReserve(messages, maxTokens, defaultMaxTokens).tokens;
}
