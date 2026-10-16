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
//
// A stream reports usage more than once: `message_start` carries the prompt, and `message_delta`
// carries running totals, where any field may be null (not reported this time). So the parts are
// kept apart and each is replaced only by a number; the sum is taken at the end. Adding them on
// every frame would let a delta whose cache fields are null cut the prompt down to its uncached part.
//
// Server tools billed per use (web search) are reported beside the tokens, in `server_tool_use`.

import type { ServerToolUse } from './usagePrice';

export interface AnthropicTokens {
  /** The whole prompt: uncached + cache reads + cache writes. Undefined when not reported. */
  input?:  number;
  /** Output tokens. Undefined when not reported. */
  output?: number;
}

/** The parts of one request's usage, as reported so far. */
export interface AnthropicUsageParts {
  uncached?:      number;
  cacheRead?:     number;
  cacheWrite?:    number;
  output?:        number;
  serverToolUse?: ServerToolUse;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Fold one usage block into `parts`, field by field: a field that is not a count leaves the earlier
 * figure as it was. `output: false` skips the output figure (a stream's opening frame carries a
 * placeholder there, not the answer's size).
 */
export function mergeAnthropicUsage(parts: AnthropicUsageParts, usage: unknown, { output = true } = {}): void {
  if (!isObject(usage)) return;
  const set = (key: Exclude<keyof AnthropicUsageParts, 'serverToolUse'>, v: unknown) => {
    const n = count(v);
    if (n !== undefined) parts[key] = n;
  };
  set('uncached', usage.input_tokens);
  set('cacheRead', usage.cache_read_input_tokens);
  set('cacheWrite', usage.cache_creation_input_tokens);
  if (output) set('output', usage.output_tokens);
  if (isObject(usage.server_tool_use)) {
    for (const [name, v] of Object.entries(usage.server_tool_use)) {
      const n = count(v);
      if (n !== undefined) parts.serverToolUse = { ...parts.serverToolUse, [name]: n };
    }
  }
}

/** Input (the whole prompt) and output from the parts. Input is known once the uncached part is. */
export function anthropicTotals(parts: AnthropicUsageParts): AnthropicTokens {
  const out: AnthropicTokens = {};
  if (parts.uncached !== undefined) out.input = parts.uncached + (parts.cacheRead ?? 0) + (parts.cacheWrite ?? 0);
  if (parts.output !== undefined) out.output = parts.output;
  return out;
}

/** Read one Anthropic usage block. Never throws; a field that is not a count is left undefined. */
export function readAnthropicTokens(usage: unknown): AnthropicTokens {
  const parts: AnthropicUsageParts = {};
  mergeAnthropicUsage(parts, usage);
  return anthropicTotals(parts);
}

/** The per-use server tools a usage block reports (`web_search_requests`, ...), or undefined. */
export function readServerToolUse(usage: unknown): ServerToolUse | undefined {
  const parts: AnthropicUsageParts = {};
  mergeAnthropicUsage(parts, usage);
  return parts.serverToolUse;
}
