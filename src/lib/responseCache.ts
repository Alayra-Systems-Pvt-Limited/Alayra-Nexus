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

import { createHash } from 'crypto';
import { redis } from './redis';
import { SHARED_NAMESPACE } from './scope';

// ── Exact-match response cache (Phase 4.5) ────────────────────────────────────
// Distinct from Phase 3's cache-*aware routing*: this caches the response itself.
// On an identical request (same model + messages + generation params) a hit is
// served straight from Redis, skipping the provider entirely — a real $0 call. The
// cache stores a normalized completion so a hit can be replayed to a streaming or a
// non-streaming client interchangeably (the `stream` flag is not part of the key).

export interface CachedCompletion {
  id:               string;
  created:          number;
  model:            string;
  provider:         string;   // the provider that originally served it (for attribution)
  content:          string;
  finishReason:     string;
  promptTokens:     number;
  completionTokens: number;
}

// The single virtual model — alias forms normalize to this so they share a cache.
const CANONICAL_MODEL = 'alayra-nexus-1';

// Generation params that change the response and therefore the cache identity.
const CACHEABLE_PARAMS = [
  'temperature', 'top_p', 'max_tokens', 'stop', 'tools', 'tool_choice',
  'response_format', 'seed', 'frequency_penalty', 'presence_penalty', 'n',
  'logprobs', 'logit_bias',
] as const;

/** Whether a request is eligible for the response cache at all. */
export function isCacheable(body: { messages?: unknown[]; n?: unknown }): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return false;
  if (typeof body.n === 'number' && body.n > 1) return false; // the cache holds a single choice
  return true;
}

/**
 * Stable cache key for a request. Excludes `stream` and `user` by construction, so
 * a streamed and a non-streamed request share one entry.
 *
 * `namespace` (Phase 5.5) partitions the cache by routing scope. A response
 * produced by a team's own BYOK key lives under `team:<id>` and is never replayed
 * to the shared pool, or to another team — an isolated team must only ever receive
 * responses its own keys paid for. Shared-pool callers use `shared` (the default),
 * which reproduces the pre-BYOK key exactly.
 */
export function responseCacheKey(body: Record<string, unknown>, namespace: string = SHARED_NAMESPACE): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const params: Record<string, unknown> = {};
  for (const p of CACHEABLE_PARAMS) if (body[p] !== undefined) params[p] = body[p];
  const canonical = JSON.stringify({ ns: namespace, model: CANONICAL_MODEL, messages, params });
  return createHash('sha256').update(canonical).digest('hex');
}

export function cacheRedisKey(key: string): string { return `nexus:respcache:${key}`; }

export async function getCached(key: string): Promise<CachedCompletion | null> {
  const raw = await redis.get(cacheRedisKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw) as CachedCompletion; } catch { return null; }
}

export async function setCached(key: string, value: CachedCompletion, ttlSeconds: number): Promise<void> {
  await redis.set(cacheRedisKey(key), JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
}

/** Reconstruct an OpenAI chat.completion object from a cache entry, for replay. */
export function toCompletionJson(c: CachedCompletion): Record<string, unknown> {
  return {
    id:      c.id,
    object:  'chat.completion',
    created: c.created,
    model:   c.model,
    choices: [{ index: 0, message: { role: 'assistant', content: c.content }, finish_reason: c.finishReason }],
    usage:   { prompt_tokens: c.promptTokens, completion_tokens: c.completionTokens, total_tokens: c.promptTokens + c.completionTokens },
  };
}

/**
 * Build a cache entry from a non-streaming completion. Returns null when there is
 * no plain-text assistant content (e.g. a tool-call-only response), which is left
 * uncached rather than replayed incorrectly.
 */
export function buildFromCompletion(data: Record<string, unknown>, provider: string): CachedCompletion | null {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first   = choices[0] as { message?: { content?: unknown }; finish_reason?: string } | undefined;
  const content = first && typeof first.message?.content === 'string' ? first.message.content : null;
  if (content === null || content === '') return null;
  const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    id:               typeof data.id === 'string' ? data.id : `chatcmpl-cache-${Date.now()}`,
    created:          typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    model:            typeof data.model === 'string' ? data.model : CANONICAL_MODEL,
    provider,
    content,
    finishReason:     first?.finish_reason ?? 'stop',
    promptTokens:     usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
  };
}

/**
 * Assemble the assistant content from a collected SSE stream. Parses each `data:`
 * line as JSON (so escaping/unicode is preserved), concatenating delta content.
 */
export function extractStreamContent(collected: string): string {
  let content = '';
  for (const line of collected.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const json = t.slice(5).trim();
    if (!json || json === '[DONE]') continue;
    try {
      const parsed = JSON.parse(json) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const delta  = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch { /* skip a partial/non-JSON keepalive line */ }
  }
  return content;
}

/** Build a cache entry from a streamed response's collected buffer + known usage. */
export function buildFromStream(collected: string, model: string, provider: string, promptTokens: number, completionTokens: number): CachedCompletion {
  return {
    id:               `chatcmpl-cache-${Date.now()}`,
    created:          Math.floor(Date.now() / 1000),
    model,
    provider,
    content:          extractStreamContent(collected),
    finishReason:     'stop',
    promptTokens,
    completionTokens,
  };
}
