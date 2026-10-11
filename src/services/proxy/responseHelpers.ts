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

import { evaluateText, type CompiledRule } from '../../lib/guardrails';
import * as metrics from '../../lib/metrics';
import { buildFromCompletion, buildFromStreamContent, setCached } from '../../lib/responseCache';

// ── Output guardrails ─────────────────────────────────────────────────────────

/** Does the rule set contain any rule that inspects the model's output? */
export function hasOutputRules(rules: CompiledRule[]): boolean {
  return rules.some((r) => (r.appliesTo ?? 'both') !== 'input');
}

/**
 * Apply output rules to a non-streaming completion in place. A block replaces the
 * choice's content with a withheld notice; a redact masks matches. Returns the
 * names of rules that fired.
 */
export function applyOutputGuardrails(data: Record<string, unknown>, rules: CompiledRule[]): string[] {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const matched = new Set<string>();
  for (const choice of choices) {
    const msg = choice && typeof choice === 'object' ? (choice as { message?: { content?: unknown } }).message : undefined;
    if (!msg || typeof msg.content !== 'string') continue;
    const verdict = evaluateText(msg.content, rules, 'output');
    verdict.matched.forEach((n) => matched.add(n));
    if (verdict.decision === 'block') {
      msg.content = '[Response withheld by content guardrails.]';
      (choice as { finish_reason?: string }).finish_reason = 'content_filter';
    } else if (verdict.decision === 'redact') {
      msg.content = verdict.text;
    }
  }
  return [...matched];
}

// ── Response cache writes ─────────────────────────────────────────────────────
// Usage and content both come off the stream as it passes now — see `streamTally.ts`. The two
// functions that used to derive them from a buffer of the whole response are gone: one held 32x
// the memory of the answer it was reading, and the other reached into JSON with a regular
// expression that returned nothing for every input, billing those answers as one output token.

/** Fire-and-forget: persist a non-streaming completion to the response cache. */
export function storeInCache(key: string | null, data: Record<string, unknown>, provider: string, ttl: number): void {
  if (!key) return;
  const entry = buildFromCompletion(data, provider); // null for tool-call-only / empty responses
  if (!entry) return;
  metrics.responseCache('store');
  void setCached(key, entry, ttl).catch(() => {});
}

/** Fire-and-forget: persist a streamed completion from the content the tally assembled. */
export function storeStreamInCache(key: string | null, content: string, model: string, provider: string, promptTokens: number, completionTokens: number, ttl: number): void {
  if (!key) return;
  const entry = buildFromStreamContent(content, model, provider, promptTokens, completionTokens);
  if (!entry.content) return; // empty / tool-call-only stream — nothing to replay
  metrics.responseCache('store');
  void setCached(key, entry, ttl).catch(() => {});
}
