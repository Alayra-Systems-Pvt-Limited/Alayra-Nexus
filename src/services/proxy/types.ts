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
import { supportsStreamUsageOption } from '../../data/providers';
import type { TraceRoutingStrategy } from '../../lib/requestTrace';

// ── Request shape ─────────────────────────────────────────────────────────────

export interface CompletionsBody {
  model?:       string;
  messages?:    unknown[];
  stream?:      boolean;
  max_tokens?:  number;
  temperature?: number;
  tools?:       unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ProxyRunOptions {
  routingStrategy?: TraceRoutingStrategy;
}

export class ProxyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Ask for provider-authoritative usage only where a live probe proved the option is safe.
 *
 * Unknown/custom providers are returned byte-for-byte untouched. A caller's other stream options
 * are retained, but include_usage is forced on for a measured provider because Nexus needs the
 * provider's billed counts for cost attribution and TPM reconciliation.
 */
export function withProviderStreamUsage(
  body: CompletionsBody,
  providerSlug: string,
  streamingUpstream: boolean,
): CompletionsBody {
  if (!streamingUpstream || !supportsStreamUsageOption(providerSlug)) return body;
  const current = body.stream_options;
  const options = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return { ...body, stream_options: { ...options, include_usage: true } };
}

// ── Stage results ─────────────────────────────────────────────────────────────
// Each stage of a proxied request either hands its result to the next stage or has already
// answered the caller (a refusal, a cache hit). The orchestrator returns the answer unchanged.

export type ProxyAnswer = FastifyReply | void;

export type Stage<T> =
  | { answered: true;  result: ProxyAnswer }
  | { answered: false; value: T };

/** The stage has answered the caller; the request ends here. */
export const answered = (result: ProxyAnswer): Stage<never> => ({ answered: true, result });

/** The stage succeeded; carry its value to the next stage. */
export const proceed = <T>(value: T): Stage<T> => ({ answered: false, value });
