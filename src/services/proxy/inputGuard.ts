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

import { getGuardrailConfig } from '../guardrails.service';
import { evaluateMessages } from '../../lib/guardrails';
import { observe, type ProxyRun } from './run';
import { hasOutputRules } from './responseHelpers';
import { answered, proceed, type Stage } from './types';

// ── Guardrails (input side) — inspect/redact/reject before forwarding ─────────

export interface GuardedRequest {
  guard:             Awaited<ReturnType<typeof getGuardrailConfig>>;
  /** Headers that report what the guardrails did; merged into every gateway response. */
  guardHeaders:      Record<string, string>;
  /** The messages to forward: the caller's, or their redacted form. */
  effectiveMessages: unknown[];
  /** Output rules exist and will be applied to a non-streamed answer. */
  outputFiltering:   boolean;
  /** Buffered-safe mode: collect a streamed answer whole so output rules can run on it. */
  bufferStream:      boolean;
}

/** Apply input rules, and decide how output rules will be applied to the answer. */
export async function guardInput(run: ProxyRun, messages: unknown[], isStream: boolean): Promise<Stage<GuardedRequest>> {
  const { reply, trace } = run;
  const guard = await getGuardrailConfig();
  const guardActive = guard.enabled && guard.compiled.length > 0;
  const guardHeaders: Record<string, string> = {};
  let effectiveMessages = messages;

  if (trace) trace.guardrails = {
    active: guardActive, input: 'pass', inputMatched: [], output: 'off', outputMatched: [],
  };

  if (guardActive) {
    guardHeaders['X-Nexus-Guardrails'] = 'on';
    const verdict = evaluateMessages(messages, guard.compiled);
    if (verdict.decision === 'block') {
      if (trace?.guardrails) { trace.guardrails.input = 'block'; trace.guardrails.inputMatched = verdict.matched; }
      if (trace) trace.refusal = { status: 400, reason: 'A content guardrail blocked the request.' };
      observe(run, 'blocked');
      return answered(reply.code(400).send({ error: 'Request blocked by content guardrails.', guardrails: verdict.matched }));
    }
    if (verdict.decision === 'redact') {
      effectiveMessages = verdict.messages;
      guardHeaders['X-Nexus-Guardrails-Input'] = `redacted:${verdict.matched.join(',')}`;
      if (trace?.guardrails) { trace.guardrails.input = 'redact'; trace.guardrails.inputMatched = verdict.matched; }
    }
  }

  const outputFiltering = guardActive && hasOutputRules(guard.compiled);
  // Buffered-safe mode: the only way to filter a streamed response is to collect it
  // first, which trades away the zero-buffer TTFT win. We never do that silently —
  // it happens only when the operator has explicitly opted in.
  const bufferStream = isStream && outputFiltering && guard.bufferedSafe;
  if (isStream && outputFiltering && !guard.bufferedSafe) {
    guardHeaders['X-Nexus-Guardrails-Output'] = 'skipped-streaming';
    if (trace?.guardrails) trace.guardrails.output = 'skipped-streaming';
  } else if (trace?.guardrails && outputFiltering) {
    trace.guardrails.output = bufferStream ? 'buffered' : 'applied';
  }

  return proceed({ guard, guardHeaders, effectiveMessages, outputFiltering, bufferStream });
}
