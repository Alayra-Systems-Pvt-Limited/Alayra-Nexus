/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── The token kinds a provider reports beyond input and output ────────────────────────────────
//
// A usage block says more than two numbers. How much of the prompt came from the provider's cache,
// how much was written to it (and for how long), how much of the output was reasoning: each is
// priced differently by the provider, and each was thrown away here, so a cache that was saving an
// operator most of their input bill looked exactly like one that was doing nothing.
//
// Every provider names them differently, and some nest them:
//
//   cache read         prompt_tokens_details.cached_tokens (OpenAI-style), cache_read_input_tokens
//                      (Anthropic), prompt_cache_hit_tokens (DeepSeek), cachedContentTokenCount (Gemini)
//   cache write        cache_creation_input_tokens (Anthropic), prompt_tokens_details.cache_write_tokens
//                      (OpenRouter, as its recorded answers in docs/provider-verification/ show)
//   cache write 5m/1h  cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens (Anthropic)
//   cache miss         prompt_cache_miss_tokens (DeepSeek)
//   reasoning          completion_tokens_details.reasoning_tokens (OpenAI-style), thoughtsTokenCount (Gemini)
//
// They are read from whichever block arrives, by name, so one reader serves every format: an
// OpenAI-compatible proxy in front of Anthropic (which passes Anthropic's names through inside an
// OpenAI-shaped block) is read exactly like Anthropic itself.
//
// Recorded as reported, never derived. `inputTokens` and `outputTokens` keep their meaning. What the
// cache kinds cost is decided in usagePrice.ts: at their own rates for Anthropic and for any model
// whose registry entry sets them, and at the input price, as before, for everyone else. Absent means
// the provider did not say, which is not the same as zero, so a field is set only when its value is
// a real count.

import type { UsageTokenKinds } from '../core/ports';

/** The extra token kinds, as a usage row carries them (see UsageTokenKinds in the usage port). */
export type UsageDetail = UsageTokenKinds;

/** The field names, in column order. */
export const USAGE_DETAIL_FIELDS = [
  'cachedInputTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cacheMissTokens', 'reasoningTokens',
] as const satisfies ReadonlyArray<keyof UsageDetail>;

// Every kind the port declares is in the list, or this fails to compile: a kind left out would be
// dropped on its way to the database without a sound.
type Unlisted = Exclude<keyof UsageDetail, (typeof USAGE_DETAIL_FIELDS)[number]>;
const _everyKindListed: Unlisted extends never ? true : Unlisted = true;

type Block = Record<string, unknown>;

const block = (v: unknown): Block | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Block : undefined);

/** The largest value an INTEGER column holds. A larger "count" would fail the whole batch insert. */
const MAX_COUNT = 2_147_483_647;

/** A token count, or undefined. A provider's null, a string, or a number no column can hold is not one. */
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? Math.round(v) : undefined;

/** The first of several names that carries a count. Providers that send two agree on the value. */
const first = (...values: unknown[]): number | undefined => {
  for (const v of values) { const n = count(v); if (n !== undefined) return n; }
  return undefined;
};

/** Read the extra token kinds from one usage block, in any provider's format. Never throws. */
export function readUsageDetail(usage: unknown): UsageDetail {
  const u = block(usage);
  if (!u) return {};
  const prompt     = block(u.prompt_tokens_details);
  const completion = block(u.completion_tokens_details);
  const creation   = block(u.cache_creation);
  const found: UsageDetail = {
    cachedInputTokens:  first(prompt?.cached_tokens, u.cache_read_input_tokens, u.prompt_cache_hit_tokens, u.cachedContentTokenCount),
    cacheWriteTokens:   first(u.cache_creation_input_tokens, prompt?.cache_write_tokens),
    cacheWrite5mTokens: count(creation?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: count(creation?.ephemeral_1h_input_tokens),
    cacheMissTokens:    count(u.prompt_cache_miss_tokens),
    reasoningTokens:    first(completion?.reasoning_tokens, u.thoughtsTokenCount),
  };
  const detail: UsageDetail = {};
  for (const k of USAGE_DETAIL_FIELDS) if (found[k] !== undefined) detail[k] = found[k];
  return detail;
}

/**
 * Fold a later report into an earlier one, field by field. A stream reports usage more than once:
 * Anthropic puts the cache counts in its first event and the output in its last, and Gemini sends a
 * running total with every chunk. A later value wins; a field the later report leaves out is kept.
 */
export function mergeUsageDetail(into: UsageDetail, from: UsageDetail): UsageDetail {
  for (const k of USAGE_DETAIL_FIELDS) if (from[k] !== undefined) into[k] = from[k];
  return into;
}
