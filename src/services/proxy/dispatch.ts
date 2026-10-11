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

// Imported through nexus.service (not its routing/ modules) so tests that mock './nexus.service'
// keep intercepting every routing call the proxy makes.
import {
  discoverBestPool, getNextCooldownSeconds, reportServerFailure, reportRateLimit, reportAuthFailure, reportTierExhausted,
  type NexusRoute,
} from '../nexus.service';
import { getSsrfPolicy } from '../ssrf.service';
import { noCapacityMessage } from '../modelCatalog.service';
import { byokKeyRequired } from '../byokOnly.service';
import { computeReserve } from '../../lib/tokenizer';
import { reconcileTpm } from '../../lib/admission';
import { sessionHash } from '../../lib/sticky';
import { stripTrailingSlash, assertSafeUrl } from '../../lib/url';
import { safeFetch } from '../../lib/safeFetch';
import { withExtraHeaders, providerAuthHeader } from '../../lib/providerHeaders';
import { isByok, isIsolated } from '../../lib/scope';
import * as metrics from '../../lib/metrics';
import { startUpstreamSpan, SpanStatusCode } from '../../lib/tracing';
import type { RequestTrace } from '../../lib/requestTrace';
import { DEFAULT_MAX_TOKENS_RESERVE, UPSTREAM_TTFT_MS } from './config';
import type { Admission } from './admission';
import type { GuardedRequest } from './inputGuard';
import { observe, type ProxyRun } from './run';
import { answered, proceed, withProviderStreamUsage, type Stage } from './types';

// ── Dispatch: choose a key, call the provider, sort out a failed answer ───────

export interface Dispatched {
  route:             NexusRoute;
  upstream:          Response;
  /** Governs the whole upstream call; the body and stream guards abort through it. */
  controller:        AbortController;
  /** Conversation hash for sticky routing; null for a one-shot request. */
  session:           string | null;
  /** Tokens reserved against the key's TPM budget, reconciled to real usage at the end. */
  reserve:           number;
  /** Release the full reservation for a request that did not (fully) run. */
  refundReservation: () => void;
  traceAttempt?:     RequestTrace['attempts'][number];
  sessionId:         string;
}

export async function dispatchUpstream(
  run: ProxyRun, admission: Admission, guarded: GuardedRequest, messages: unknown[], isStream: boolean,
): Promise<Stage<Dispatched>> {
  const { body, reply, reqHeaders, team, trace } = run;
  const { scope, pinnedModelId, strategyWeight, overBudgetDowngrade } = admission;
  const { effectiveMessages, bufferStream } = guarded;

  const reserve  = computeReserve(effectiveMessages, body.max_tokens, DEFAULT_MAX_TOKENS_RESERVE);
  // Cache-aware sticky routing: pin a continuing conversation to its last key.
  const session  = sessionHash({ messages, user: body.user }, reqHeaders);
  // OpenAI-standard end-user id, used to enforce each key's Max Users cap. Absent → no per-user
  // enforcement (see admitUser).
  const userId   = typeof body.user === 'string' ? body.user : null;

  // An over-budget team on the "downgrade" action is routed to the fast (cheapest) tier regardless of
  // its normal preference, so it keeps working at the lowest cost rather than being cut off.
  const preferredTier = overBudgetDowngrade ? 'fast' : (team?.assignedTier ?? null);
  const route = pinnedModelId
    ? await discoverBestPool(reserve, session, scope, 'chat', userId, preferredTier, pinnedModelId)
    : await discoverBestPool(reserve, session, scope, 'chat', userId, preferredTier, null, strategyWeight);
  if (!route) {
    // A byok-only team with no key of its own that could serve this is told to add one (P1.1).
    const needsKey = await byokKeyRequired(scope, 'chat', { pinnedModelId });
    if (needsKey) {
      if (trace) trace.refusal = { status: 403, reason: 'The team has no provider key of its own that can serve this request.' };
      observe(run, 'client_error');
      return answered(reply.code(403).send(needsKey));
    }
    if (trace) trace.refusal = { status: 503, reason: pinnedModelId
      ? 'No key had capacity for the model that was pinned.'
      : 'No pool had a key with capacity for this request.' };
    observe(run, 'no_capacity');
    const isolated = isIsolated(scope);
    if (isolated) metrics.byokRequest('isolated_block');
    // Operator alert (Phase 6.4b): the gateway is refusing chat traffic. Fire-and-forget,
    // coalesced to one message per window so a sustained outage does not flood.
    void reportTierExhausted('chat', isolated).catch(() => {});
    const retryAfter = await getNextCooldownSeconds();
    return answered(reply
      .code(503)
      .header('Retry-After', String(retryAfter))
      .send({
        error: await noCapacityMessage({ isolated, pinnedModelId, retryAfter }),
        retryAfter,
      }));
  }

  // Route chosen: record provider dispatch and (if applicable) a prompt-cache hit.
  run.tier          = route.tier;
  run.routeProvider = route.providerSlug;
  run.routeModel    = route.modelString;
  // Field by field, never `...route` — the route carries `decryptedKey`, and a spread would put a
  // live provider credential into an object that is serialised into an admin API response. See
  // #117 and lib/requestTrace.ts. `keyMask` is what exists so this has a safe answer.
  if (trace) trace.route = {
    provider:   route.providerSlug,
    modelString: route.modelString,
    modelId:    route.modelId,
    tier:       route.tier,
    keyId:      route.keyId,
    keyMask:    route.keyMask,
    sticky:     route.sticky,
    byok:       route.byok,
    downgraded: route.wasDowngrade,
    probe:      route.isProbe,
    keyStatus:  route.keyStatus,
    rpmLimit:   route.rpmLimit,
    tpmLimit:   route.tpmLimit,
  };
  const traceAttempt: RequestTrace['attempts'][number] | undefined = trace ? {
    provider: route.providerSlug, modelString: route.modelString, tier: route.tier, keyMask: route.keyMask,
  } : undefined;
  if (traceAttempt) trace!.attempts.push(traceAttempt);
  metrics.providerRequest(route.providerSlug);
  if (route.sticky) metrics.cacheHit();
  // Only a key-owning team can produce a BYOK outcome; pooled callers are not counted.
  if (isByok(scope)) metrics.byokRequest(route.byok ? 'own' : 'fallback');

  const keyId = route.keyId;
  // RPM stays consumed on purpose — the request was attempted against the provider.
  const refundReservation = () => { void reconcileTpm(keyId, reserve, 0).catch(() => {}); };

  // Defense in depth: base URLs are SSRF-validated when a provider is created, but
  // re-check on the hot path so a route can never reach a blocked internal host.
  try {
    assertSafeUrl(stripTrailingSlash(route.baseUrl), await getSsrfPolicy());
  } catch (err) {
    refundReservation();
    if (trace) trace.refusal = { status: 502, reason: 'The pool\'s base URL is blocked by the network policy.' };
    observe(run, 'ssrf_blocked');
    return answered(reply.code(502).send({ error: err instanceof Error ? err.message : 'Upstream blocked by SSRF policy.' }));
  }

  const upstreamUrl  = `${stripTrailingSlash(route.baseUrl)}/chat/completions`;
  // Forward the (possibly redacted) messages. In buffered-safe mode we request a
  // non-streamed response from upstream so we can inspect it before replaying it.
  const upstreamBody = withProviderStreamUsage(
    { ...body, messages: effectiveMessages, model: route.modelString, ...(bufferStream ? { stream: false } : {}) },
    route.providerSlug,
    isStream && !bufferStream,
  );
  const headers: Record<string, string> = withExtraHeaders(route.extraHeaders, {
    'Content-Type': 'application/json',
    ...providerAuthHeader(route.authHeader, route.authPrefix, route.decryptedKey),
  });
  const sessionId = `proxy-${Date.now()}`;

  // A single controller governs the whole upstream call. A time-to-first-byte
  // timer aborts if response headers never arrive; it is cleared once they do.
  const controller = new AbortController();
  const ttftTimer = setTimeout(() => controller.abort(), UPSTREAM_TTFT_MS);

  // OTel: span for the gateway → provider call (no-op unless an SDK is attached).
  run.tFetch = Date.now();
  const span = startUpstreamSpan({ 'nexus.provider': route.providerSlug, 'nexus.tier': route.tier, 'nexus.model': route.modelString });

  let upstream: Response;
  try {
    upstream = await safeFetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: controller.signal });
  } catch (err) {
    clearTimeout(ttftTimer);
    refundReservation();
    // A timeout/connection failure is a server-side fault: feed the breaker.
    await reportServerFailure(keyId, route.isProbe);
    metrics.providerError(route.providerSlug, 'timeout');
    span.recordException(err as Error); span.setStatus({ code: SpanStatusCode.ERROR }); span.end();
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (traceAttempt) traceAttempt.outcome = aborted ? 'timeout' : 'connection_error';
    if (trace) trace.refusal = { status: 504, reason: aborted
      ? `The provider sent no response headers within ${UPSTREAM_TTFT_MS}ms.`
      : 'The connection to the provider failed.' };
    observe(run, 'upstream_error');
    return answered(reply.code(504).send({ error: aborted ? 'Upstream timed out before responding.' : 'Upstream connection failed.' }));
  }
  clearTimeout(ttftTimer);
  const ttfbMs = Date.now() - run.tFetch;
  if (trace) trace.timing.ttfbMs = ttfbMs;
  if (traceAttempt) traceAttempt.ttfbMs = ttfbMs;
  metrics.observeTtfb((Date.now() - run.tFetch) / 1000);
  span.setAttribute('http.status_code', upstream.status);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Upstream error');
    // Classify the failure for the circuit breaker: 429 is flat back-pressure,
    // 401/403 is a bad credential (auto-ban on repeat), 5xx is a server fault
    // (strike/escalate). Other 4xx are the caller's error — the key is fine.
    if (upstream.status === 429)                             { await reportRateLimit(keyId); metrics.providerError(route.providerSlug, 'rate_limit'); }
    else if (upstream.status === 401 || upstream.status === 403) { await reportAuthFailure(keyId); metrics.providerError(route.providerSlug, 'auth'); }
    else if (upstream.status >= 500)                         { await reportServerFailure(keyId, route.isProbe); metrics.providerError(route.providerSlug, 'server'); }
    span.setStatus({ code: SpanStatusCode.ERROR }); span.end();
    refundReservation(); // rejected upstream — return the reserved budget
    if (traceAttempt) {
      traceAttempt.status = upstream.status;
      traceAttempt.outcome = upstream.status === 429 ? 'rate_limited'
        : upstream.status === 401 || upstream.status === 403 ? 'auth_error' : 'provider_error';
    }
    if (trace) trace.refusal = { status: upstream.status, reason: `The provider answered ${upstream.status}.` };
    // 4xx (other than 429) is the caller's bad request; 429/auth/5xx is an upstream fault.
    observe(run, upstream.status >= 500 || upstream.status === 429 || upstream.status === 401 || upstream.status === 403 ? 'upstream_error' : 'client_error');
    return answered(reply.code(upstream.status).send(errText));
  }
  if (traceAttempt) traceAttempt.status = upstream.status;
  span.end(); // upstream responded OK

  return proceed({ route, upstream, controller, session, reserve, refundReservation, traceAttempt, sessionId });
}
