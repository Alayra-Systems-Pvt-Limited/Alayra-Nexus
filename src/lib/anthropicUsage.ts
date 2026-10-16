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

// ── Input and output tokens, as Anthropic's own Messages API reports them ────────────────────────
//
// Anthropic splits the prompt three ways: `input_tokens` is only the part read neither from nor into
// the cache, `cache_read_input_tokens` came from the cache, and `cache_creation_input_tokens` was
// written to it. A usage row's `inputTokens` means the whole prompt (OpenAI's `prompt_tokens`, which
// counts cached tokens too), so the three are added here. The split itself is kept as the row's
// cache columns (usageDetail.ts), not lost.

export interface AnthropicTokens {
  /** The whole prompt: uncached + cache reads + cache writes. Undefined when not reported. */
  input?:  number;
  /** Output tokens. Undefined when not reported. */
  output?: number;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

/** Read one Anthropic usage block. Never throws; a field that is not a count is left undefined. */
export function readAnthropicTokens(usage: unknown): AnthropicTokens {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {};
  const u = usage as Record<string, unknown>;
  const uncached = count(u.input_tokens);
  const out: AnthropicTokens = {};
  if (uncached !== undefined) {
    out.input = uncached + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0);
  }
  const output = count(u.output_tokens);
  if (output !== undefined) out.output = output;
  return out;
}
