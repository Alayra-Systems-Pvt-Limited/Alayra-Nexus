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
// keep intercepting every breaker report.
import { reportServerFailure, reportRateLimit, reportAuthFailure, type NexusRoute } from '../nexus.service';
import * as metrics from '../../lib/metrics';
import type { RequestTrace } from '../../lib/requestTrace';
import type { Departure } from '../../lib/clientDeparture';
import { strippedHeader } from './anthropicPolicy';
import { observe, type ProxyRun } from './run';
import type { ProxyAnswer } from './types';

// ── A provider that answered with an error ────────────────────────────────────────────────────

/** What a provider's error says about the key that sent the request. */
export type FailureKind = 'rate_limit' | 'auth' | 'server' | 'client';

/**
 * Anthropic names the cause in `error.type` (https://platform.claude.com/docs/en/api/errors). Only
 * `authentication_error` says the key itself is bad. A `permission_error` is about what was asked for
 * (a feature or resource the organisation lacks), and on the native path the caller writes the
 * request, so it counts against no key: two such requests must not ban a key every tenant shares. A
 * `billing_error` cools the key like a rate limit, since nothing sent on it succeeds until the
 * operator acts. A type not listed here is judged by its status, never as a credential fault.
 */
const ANTHROPIC_KINDS = new Map<string, FailureKind>([
  ['authentication_error', 'auth'],
  ['rate_limit_error',     'rate_limit'],
  ['billing_error',        'rate_limit'],
  ['overloaded_error',     'server'],
  ['api_error',            'server'],
  ['timeout_error',        'server'],
  ['permission_error',     'client'],
]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

/** The `error.type` of an Anthropic error body, or undefined when the body is not one. */
export function anthropicErrorKind(text: string): string | undefined {
  const b = parse(text);
  return isObject(b) && b.type === 'error' && isObject(b.error) && typeof b.error.type === 'string' ? b.error.type : undefined;
}

/**
 * Classify a failed answer for the circuit breaker. 429 is back-pressure, 401/403 a bad credential (a
 * ban is requested on repeat), 5xx a server fault; any other 4xx is the caller's. Anthropic's own
 * API, answering a native request, is classified by the type it names instead (see above).
 */
export function classifyFailure(status: number, text: string, native: boolean): FailureKind {
  const named = native ? ANTHROPIC_KINDS.get(anthropicErrorKind(text) ?? '') : undefined;
  if (named) return named;
  if (status === 429) return 'rate_limit';
  if (!native && (status === 401 || status === 403)) return 'auth';
  return status >= 500 ? 'server' : 'client';
}

/** Generic words for the errors whose own words can name the account behind a shared key. */
const SCRUBBED: Record<number, string> = {
  401: 'The provider refused the credential of the pool that served this request.',
  403: 'The provider refused this request for the pool that served it.',
  429: 'The provider is rate limiting the pool that served this request. Retry later.',
};

/**
 * The error body to give the caller. On a shared key, a provider's own message for a refused
 * credential or a rate limit can name the operator's organisation or account, which a tenant (a
 * caller using a team's key) has no business reading; the error's type (and code) is kept and the
 * message replaced. The operator's own key, and a team on its own provider key, get the provider's
 * words unchanged: the account is theirs.
 */
export function callerErrorBody(status: number, text: string, tenantOnSharedKey: boolean): string {
  const message = SCRUBBED[status];
  if (!tenantOnSharedKey || message === undefined) return text;
  const b = parse(text);
  if (isObject(b) && b.type === 'error' && isObject(b.error)) {
    return JSON.stringify({
      type: 'error', error: { type: b.error.type, message },
      ...(typeof b.request_id === 'string' ? { request_id: b.request_id } : {}),
    });
  }
  const err = isObject(b) && isObject(b.error) ? b.error : {};
  return JSON.stringify({ error: {
    message,
    ...(typeof err.type === 'string' ? { type: err.type } : {}),
    ...(typeof err.code === 'string' ? { code: err.code } : {}),
  } });
}

/**
 * Anthropic's response headers a caller can use: when to retry, whether to, and the id its support
 * asks for. Nothing else is relayed (no organisation or rate-limit detail of the operator's account).
 */
const RELAYED = ['retry-after', 'request-id', 'x-should-retry'] as const;

/** The gateway's headers on a native answer, error or not: the marker, what was stripped, and RELAYED. */
export function nativeAnswerHeaders(upstream: Response, stripped: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { 'X-Nexus-Native': 'anthropic' };
  const removed = strippedHeader(stripped);
  if (removed) out['X-Nexus-Stripped'] = removed;
  for (const name of RELAYED) {
    const v = upstream.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

export interface FailedCall {
  route:             NexusRoute;
  upstream:          Response;
  /** What was stripped from a native request; null when the request was translated. */
  nativeStripped:    readonly string[] | null;
  departure:         Departure;
  refundReservation: () => void;
  traceAttempt?:     RequestTrace['attempts'][number];
}

const TRACE_OUTCOME = { rate_limit: 'rate_limited', auth: 'auth_error', server: 'provider_error', client: 'provider_error' } as const;

/** Report the failure to the breaker and metrics, and pass the provider's error on to the caller. */
export async function answerUpstreamFailure(run: ProxyRun, call: FailedCall): Promise<ProxyAnswer> {
  const { route, upstream, nativeStripped, departure, refundReservation, traceAttempt } = call;
  const { reply, trace } = run;
  const errText = await upstream.text().catch(() => 'Upstream error');
  departure.release();
  const native = nativeStripped !== null;
  const kind = classifyFailure(upstream.status, errText, native);
  if (kind === 'rate_limit')  { await reportRateLimit(route.keyId); metrics.providerError(route.providerSlug, 'rate_limit'); }
  else if (kind === 'auth')   { await reportAuthFailure(route.keyId); metrics.providerError(route.providerSlug, 'auth'); }
  else if (kind === 'server') { await reportServerFailure(route.keyId, route.isProbe); metrics.providerError(route.providerSlug, 'server'); }
  refundReservation(); // rejected upstream: return the reserved budget
  if (traceAttempt) { traceAttempt.status = upstream.status; traceAttempt.outcome = TRACE_OUTCOME[kind]; }
  if (trace) trace.refusal = { status: upstream.status, reason: `The provider answered ${upstream.status}.` };
  observe(run, kind === 'client' ? 'client_error' : 'upstream_error');
  if (nativeStripped) for (const [k, v] of Object.entries(nativeAnswerHeaders(upstream, nativeStripped))) reply.header(k, v);
  return reply.code(upstream.status).send(callerErrorBody(upstream.status, errText, !!run.teamKeyId && !route.byok));
}
