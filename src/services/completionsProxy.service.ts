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
import type { RequestTrace } from '../lib/requestTrace';
import { admitRequest } from './proxy/admission';
import { guardInput } from './proxy/inputGuard';
import { lookUpResponseCache } from './proxy/cacheLookup';
import { dispatchUpstream } from './proxy/dispatch';
import { deliverBuffered, deliverJson, gatewayHeaders, type Delivery } from './proxy/deliver';
import { deliverStream } from './proxy/deliverStream';
import { createProxyRun } from './proxy/run';
import type { CompletionsBody, ProxyRunOptions } from './proxy/types';

// The caller's team now lives with the rest of the caller context in the core; re-exported here
// because existing callers and tests import it from this module.
import type { TeamContext } from '../core/context';
export type { TeamContext };

// The request shape and its helpers moved to proxy/types.ts; re-exported because routes, the
// playground, and the tests all import them from here.
export { ProxyError, withProviderStreamUsage } from './proxy/types';
export type { CompletionsBody, ProxyRunOptions } from './proxy/types';

// ── The proxy, stage by stage ─────────────────────────────────────────────────
// Each stage lives in services/proxy/ and either answers the caller itself (a refusal, a cache
// hit, a provider error) or hands its result to the next. The order is the contract: admission,
// input guardrails, the response cache, the provider call, then one of three ways to deliver.

export async function handleProxy(
  body: CompletionsBody,
  reply: FastifyReply,
  teamKeyId?: string,
  reqHeaders: Record<string, unknown> = {},
  team?: TeamContext,
  // Optional, and last, so every existing caller is untouched — `/v1/chat/completions` and the
  // Anthropic wrapper both pass nothing and behave exactly as before. Pass one and it is filled in
  // as the request proceeds; see lib/requestTrace.ts for what may and may not go in it.
  trace?: RequestTrace,
  options: ProxyRunOptions = {},
): Promise<FastifyReply | void> {
  // One record of the request in flight; the clock for every latency figure starts here.
  const run = createProxyRun({ body, reply, teamKeyId, reqHeaders, team, trace });

  // Scope, model resolution, routing strategy, and the team budget gate.
  const admission = await admitRequest(run, options);
  if (admission.answered) return admission.result;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;

  // Input guardrails: block, redact, or pass; and how output rules will run.
  const guarded = await guardInput(run, messages, isStream);
  if (guarded.answered) return guarded.result;

  // Exact-match response cache, checked before any provider is chosen.
  const cache = await lookUpResponseCache(run, admission.value.scope, admission.value.pinnedModelId, isStream, options.anthropicNative?.body);
  if (cache.answered) return cache.result;

  // Choose a key and call the provider; a failed call is answered inside.
  const dispatched = await dispatchUpstream(run, admission.value, guarded.value, messages, isStream, options.anthropicNative);
  if (dispatched.answered) return dispatched.result;

  // The provider answered 2xx: deliver it the way the caller (and the guardrails) asked for. An
  // answer relayed untouched from Anthropic's own API is not stored in the response cache: the
  // cache holds the translated form, and a hit is replayed through the translation.
  const cacheMiss = dispatched.value.native ? { ...cache.value, cacheStoreKey: null } : cache.value;
  const delivery: Delivery = {
    run,
    dispatched:   dispatched.value,
    guarded:      guarded.value,
    cache:        cacheMiss,
    nexusHeaders: gatewayHeaders(dispatched.value, guarded.value, cacheMiss),
  };
  if (guarded.value.bufferStream) return deliverBuffered(delivery);
  const streamBody = dispatched.value.upstream.body;
  if (isStream && streamBody) return deliverStream(delivery, streamBody);
  return deliverJson(delivery);
}
