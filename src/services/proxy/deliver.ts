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

// Imported through nexus.service so tests that mock './nexus.service' still intercept it.
import { reportSuccess } from '../nexus.service';
import { countMessageTokens } from '../../lib/tokenizer';
import { reconcileTpm } from '../../lib/admission';
import { setStickyKeyId } from '../../lib/sticky';
import * as metrics from '../../lib/metrics';
import { UPSTREAM_BODY_MS } from './config';
import type { CacheMiss } from './cacheLookup';
import type { Dispatched } from './dispatch';
import type { GuardedRequest } from './inputGuard';
import { applyOutputGuardrails, storeInCache } from './responseHelpers';
import { observe, recordUsage, routeUsage, stampUsage, type ProxyRun } from './run';
import { openEventStream, toSingleSseChunk } from './sse';
import type { ProxyAnswer } from './types';

// ── Delivery: hand a successful provider answer to the caller ─────────────────

/** Everything a delivery path needs once the provider has answered 2xx. */
export interface Delivery {
  run:          ProxyRun;
  dispatched:   Dispatched;
  guarded:      GuardedRequest;
  cache:        CacheMiss;
  /** The gateway's own response headers (route, cache, guardrails). */
  nexusHeaders: Record<string, string>;
}

/** The headers every successful answer carries, built once from the route and the stages before. */
export function gatewayHeaders(dispatched: Dispatched, guarded: GuardedRequest, cache: CacheMiss): Record<string, string> {
  const { route } = dispatched;
  return {
    'X-Nexus-Model':          route.modelString,
    'X-Nexus-Provider':       route.providerSlug,
    'X-Nexus-Tier':           route.tier,
    ...(route.wasDowngrade ? { 'X-Nexus-Tier-Downgrade': 'true' } : {}),
    ...(route.sticky        ? { 'X-Nexus-Sticky': 'true' } : {}),
    ...(route.byok          ? { 'X-Nexus-BYOK': 'true' } : {}),
    ...(cache.cacheStoreKey ? { 'X-Nexus-Cache': 'miss' } : {}),
    ...guarded.guardHeaders,
  };
}

/**
 * On a healthy response, close the breaker and pin this session to the key so
 * follow-up turns reuse the provider's prompt cache.
 */
export function markHealthy({ route, session }: Dispatched): void {
  void reportSuccess(route.keyId, route.isProbe).catch(() => {});
  if (session) void setStickyKeyId(session, route.keyId).catch(() => {});
}

/** Read a whole JSON answer under its own timer; null when it timed out or was malformed. */
async function readJsonBody(d: Delivery): Promise<Record<string, unknown> | null> {
  const { upstream, controller, refundReservation, traceAttempt } = d.dispatched;
  const bodyTimer = setTimeout(() => controller.abort(), UPSTREAM_BODY_MS);
  try {
    return await upstream.json() as Record<string, unknown>;
  } catch {
    refundReservation();
    if (traceAttempt) traceAttempt.outcome = 'provider_error';
    observe(d.run, 'upstream_error');
    return null;
  } finally {
    clearTimeout(bodyTimer);
  }
}

/** Record a completed JSON answer: metrics, cache, TPM reconciliation, and the usage row. */
async function settleJson(d: Delivery, data: Record<string, unknown>): Promise<void> {
  const { run, dispatched, guarded, cache } = d;
  const { route, reserve, traceAttempt, sessionId } = dispatched;
  const usageObj     = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const inputTokens  = usageObj?.prompt_tokens     ?? countMessageTokens(guarded.effectiveMessages);
  const outputTokens = usageObj?.completion_tokens  ?? 1;
  stampUsage(run, inputTokens, outputTokens);
  observe(run, 'success'); metrics.addTokens(inputTokens, outputTokens);
  storeInCache(cache.cacheStoreKey, data, route.providerSlug, cache.cacheCfg.ttlSeconds); // cache the post-guardrails response
  void reconcileTpm(route.keyId, reserve, inputTokens + outputTokens).catch(() => {});
  if (traceAttempt) traceAttempt.outcome = 'success';
  await recordUsage(run, routeUsage(run, route, sessionId, inputTokens, outputTokens));
}

/**
 * Buffered-safe streaming: collect the full (non-streamed) upstream response,
 * apply output guardrails, then replay it to the client as a single SSE chunk.
 */
export async function deliverBuffered(d: Delivery): Promise<ProxyAnswer> {
  const { reply, trace } = d.run;
  const data = await readJsonBody(d);
  if (!data) return reply.code(504).send({ error: 'Upstream response timed out or was malformed.' });
  markHealthy(d.dispatched);

  const matched = applyOutputGuardrails(data, d.guarded.guard.compiled);
  if (trace?.guardrails) trace.guardrails.outputMatched = matched;
  const outHeaders = { ...d.nexusHeaders, 'X-Nexus-Guardrails-Output': matched.length ? `buffered:${matched.join(',')}` : 'buffered' };

  openEventStream(reply, outHeaders);
  reply.raw.write(toSingleSseChunk(data));
  reply.raw.end();

  await settleJson(d, data);
}

/** Non-streaming: bound the body read with its own timer, filter it, then return it whole. */
export async function deliverJson(d: Delivery): Promise<ProxyAnswer> {
  const { reply, trace } = d.run;
  const data = await readJsonBody(d);
  if (!data) return reply.code(504).send({ error: 'Upstream response timed out or was malformed.' });
  markHealthy(d.dispatched);

  // Guardrails (output side) — safe here because the full body is already buffered.
  if (d.guarded.outputFiltering) {
    const matched = applyOutputGuardrails(data, d.guarded.guard.compiled);
    if (trace?.guardrails) trace.guardrails.outputMatched = matched;
    if (matched.length) d.nexusHeaders['X-Nexus-Guardrails-Output'] = `applied:${matched.join(',')}`;
  }

  await settleJson(d, data);

  for (const [k, v] of Object.entries(d.nexusHeaders)) reply.header(k, v);
  return reply.code(200).send(data);
}
