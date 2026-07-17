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
import {
  discoverBestPool, getNextCooldownSeconds,
  reportSuccess, reportServerFailure, reportRateLimit, reportAuthFailure, reportTierExhausted,
} from './nexus.service';
import { recordTokenUsage, recordOutcome } from './token.service';
import { reconcileTpm }         from '../lib/admission';
import { countTokens }          from '../lib/tokenizer';
import { stripTrailingSlash, assertSafeUrl } from '../lib/url';
import { withExtraHeaders, providerAuthHeader } from '../lib/providerHeaders';
import { getSsrfPolicy }         from './ssrf.service';
import { checkTeamBudget, type BudgetPeriod, type OverBudgetAction } from './budget.service';
import { resolveRequestScope }   from './byok.service';
import { isByok, isIsolated }    from '../lib/scope';
import type { Capability }       from '../lib/modelSelect';
import type { TeamContext }      from './completionsProxy.service';
import * as metrics              from '../lib/metrics';

// ── Generic non-chat dispatcher (Phase 6.3) ───────────────────────────────────
// Embeddings, completions, and the modalities that follow are JSON in / JSON out with
// no `messages`, no conversation, and no chat SSE — so they cannot reuse the chat
// handler's body. What they *do* reuse is everything that matters: the same model-first
// routing, circuit breaker, atomic admission, BYOK isolation, budgets, usage pipeline,
// and SSRF guard. This dispatcher composes those shared primitives; it is not a second
// routing path, only a second, simpler transport for non-chat request shapes.

const UPSTREAM_TTFT_MS = parseInt(process.env.UPSTREAM_TTFT_MS ?? '20000', 10);
const UPSTREAM_BODY_MS = parseInt(process.env.UPSTREAM_BODY_MS ?? '60000', 10);
const DEFAULT_MAX_TOKENS_RESERVE = parseInt(process.env.NEXUS_DEFAULT_MAX_TOKENS ?? '2048', 10);

/**
 * Non-token billing (Phase 6.3b). Endpoints whose cost is not a token count — image
 * generation bills per image — describe how to count their unit here. Absent = the
 * default token path (embeddings, completions): usage is read from `response.usage`.
 */
export interface BillingSpec {
  unit: string;                                       // "image" (later: "character", "second")
  quantityFromResponse?: (data: Record<string, unknown>) => number | undefined;
  quantityFromRequest?:  (body: Record<string, unknown>) => number;
}

export interface DispatchOptions {
  capability:   Capability;   // which model capability serves this endpoint
  upstreamPath: string;       // '/embeddings' | '/completions' | '/images/generations' | '/audio/speech'
  reserveTokens: number;      // TPM admission reserve
  billing?:     BillingSpec;  // set for non-token modalities; omit for token endpoints
  // How the upstream response is read. 'json' (default) parses a JSON body; 'binary'
  // streams the bytes back untouched (text-to-speech returns audio, not JSON), carrying
  // the upstream Content-Type. A binary response has no usage block, so a 'binary'
  // endpoint must bill from the request via `billing.quantityFromRequest`.
  responseMode?: 'json' | 'binary';
  // Builds the upstream request body once a model is chosen. Set for multipart uploads
  // (audio transcription): the caller rebuilds the form with the routed model injected,
  // and fetch sets Content-Type itself so the multipart boundary is correct. When
  // omitted, the JSON `body` is forwarded with the routed model merged in.
  requestBuild?: (routedModel: string) => FormData;
  team?:        TeamContext;
  teamKeyId?:   string;
}

/** Token usage from a non-chat response. Embeddings report input only. */
export function extractTokenUsage(data: Record<string, unknown>): { input: number; output: number } {
  const u = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  return { input: Number(u.prompt_tokens ?? u.total_tokens ?? 0), output: Number(u.completion_tokens ?? 0) };
}

/** Estimated tokens in an /embeddings request (`input` is a string or array of strings). */
export function embeddingReserve(body: Record<string, unknown>): number {
  const input = body.input;
  const text = Array.isArray(input) ? input.map(String).join('\n') : String(input ?? '');
  return Math.max(1, countTokens(text));
}

/** Estimated reserve for a /completions request: prompt tokens plus the output cap. */
export function completionReserve(body: Record<string, unknown>): number {
  const prompt = body.prompt;
  const text = Array.isArray(prompt) ? prompt.map(String).join('\n') : String(prompt ?? '');
  const max = typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_TOKENS_RESERVE;
  return Math.max(1, countTokens(text)) + Math.max(0, max);
}

/**
 * Nominal admission reserve for an /images/generations request. Images are billed per
 * image, not per token, so this only claims a small TPM slot to keep the per-key rate
 * limiter honest; the full reserve is refunded on success (no tokens are consumed).
 */
export function imageReserve(body: Record<string, unknown>): number {
  return Math.max(1, countTokens(String(body.prompt ?? '')));
}

/** Images returned by an /images/generations response (`data[]`), for per-image billing. */
export function imageQuantity(data: Record<string, unknown>): number | undefined {
  return Array.isArray(data.data) ? data.data.length : undefined;
}

/** Nominal admission reserve for an /audio/speech request, from the text to be spoken. */
export function speechReserve(body: Record<string, unknown>): number {
  return Math.max(1, countTokens(String(body.input ?? '')));
}

/** Characters in an /audio/speech request — the unit text-to-speech is billed in. */
export function speechCharacters(body: Record<string, unknown>): number {
  return String(body.input ?? '').length;
}

/**
 * Forward a non-chat request through the shared routing + resilience path. `body` is a
 * plain JSON object; the model is replaced with the one routing selected, and the call
 * goes to `opts.upstreamPath` on the chosen provider. Streaming is not offered here —
 * these modalities are one-shot — so any `stream` flag is dropped.
 */
export async function dispatchProxy(
  body: Record<string, unknown>,
  reply: FastifyReply,
  opts: DispatchOptions,
): Promise<FastifyReply | void> {
  const { team, teamKeyId, capability, upstreamPath, reserveTokens, billing, requestBuild } = opts;
  const t0 = Date.now();
  let tier: string | undefined = undefined; // set once a route is chosen (read in the closure before then)
  let routeProvider: string | null = null;  // ditto — a request that fails before routing has neither
  let routeModel:    string | null = null;
  // One call per exit, so this is the seam that persists an outcome (Phase 7.5). Failures are
  // written here; a success is written by recordTokenUsage, which also carries tokens and cost.
  const observe = (o: metrics.RequestOutcome) => {
    const elapsed = Date.now() - t0;
    metrics.observeRequest(o, tier, elapsed / 1000);
    if (o !== 'success') {
      void recordOutcome({
        outcome: o, latencyMs: elapsed, provider: routeProvider, modelName: routeModel, nexusTeamKeyId: teamKeyId,
      }).catch(() => {});
    }
  };
  const responseMode = opts.responseMode ?? 'json';

  // Team budget gate — before any provider work. Over-budget behaviour is per-team (Phase 7.10):
  // "block" refuses here, "notify" admits silently, "downgrade" admits but pins routing to fast below.
  let overBudgetDowngrade = false;
  if (team && team.budgetUsd != null) {
    const budget = await checkTeamBudget(team.id, team.budgetUsd, team.budgetPeriod as BudgetPeriod, (team.overBudgetAction ?? 'block') as OverBudgetAction);
    if (!budget.allowed) {
      observe('budget_blocked');
      return reply.code(429).header('Retry-After', String(budget.retryAfterSeconds))
        .send({ error: `Team budget exhausted: $${budget.spendUsd.toFixed(4)} of $${team.budgetUsd} used. Resets in ${budget.retryAfterSeconds}s.`, retryAfter: budget.retryAfterSeconds });
    }
    overBudgetDowngrade = budget.downgrade;
  }

  const scope = await resolveRequestScope(team);
  // OpenAI-standard end-user id (when the caller sends one), for per-key Max Users enforcement.
  const userId = typeof body.user === 'string' ? body.user : null;
  // A downgraded (over-budget) team is pinned to the fast/cheapest tier regardless of its preference.
  const preferredTier = overBudgetDowngrade ? 'fast' : (team?.assignedTier ?? null);
  const route = await discoverBestPool(reserveTokens, null, scope, capability, userId, preferredTier);
  if (!route) {
    observe('no_capacity');
    const isolated = isIsolated(scope);
    if (isolated) metrics.byokRequest('isolated_block');
    // Operator alert (Phase 6.4b): no key can serve this capability. Same uniform tap as
    // the chat path; fire-and-forget and coalesced.
    void reportTierExhausted(capability, isolated).catch(() => {});
    const retryAfter = await getNextCooldownSeconds();
    return reply.code(503).header('Retry-After', String(retryAfter)).send({
      error: `No available model for "${capability}". Add a ${capability}-capable model in the Models tab, or all matching keys are rate-limited (retry in ${retryAfter}s).`,
      retryAfter,
    });
  }

  tier          = route.tier;
  routeProvider = route.providerSlug;
  routeModel    = route.modelString;
  metrics.providerRequest(route.providerSlug);
  if (isByok(scope)) metrics.byokRequest(route.byok ? 'own' : 'fallback');

  const keyId = route.keyId;
  const refund = () => { void reconcileTpm(keyId, reserveTokens, 0).catch(() => {}); };

  try {
    assertSafeUrl(stripTrailingSlash(route.baseUrl), await getSsrfPolicy());
  } catch (err) {
    refund(); observe('ssrf_blocked');
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'Upstream blocked by SSRF policy.' });
  }

  const url = `${stripTrailingSlash(route.baseUrl)}${upstreamPath}`;
  const headers: Record<string, string> = withExtraHeaders(
    route.extraHeaders,
    providerAuthHeader(route.authHeader, route.authPrefix, route.decryptedKey),
  );
  // Multipart upload: the caller rebuilds the form with the routed model, and fetch sets
  // its own multipart Content-Type (boundary). Otherwise forward JSON, dropping any
  // stream flag (these endpoints are one-shot) and injecting the model Nexus chose.
  let fetchBody: FormData | string;
  if (requestBuild) {
    fetchBody = requestBuild(route.modelString);
  } else {
    const { stream: _stream, ...rest } = body;
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify({ ...rest, model: route.modelString });
  }

  const controller = new AbortController();
  let ttft: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), UPSTREAM_TTFT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: fetchBody, signal: controller.signal });
  } catch (err) {
    if (ttft) clearTimeout(ttft);
    refund();
    await reportServerFailure(keyId, route.isProbe);
    metrics.providerError(route.providerSlug, 'timeout');
    observe('upstream_error');
    const aborted = err instanceof Error && err.name === 'AbortError';
    return reply.code(504).send({ error: aborted ? 'Upstream timed out before responding.' : 'Upstream connection failed.' });
  }
  if (ttft) { clearTimeout(ttft); ttft = null; }
  metrics.observeTtfb((Date.now() - t0) / 1000);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Upstream error');
    if (upstream.status === 429)                                  { await reportRateLimit(keyId);  metrics.providerError(route.providerSlug, 'rate_limit'); }
    else if (upstream.status === 401 || upstream.status === 403)  { await reportAuthFailure(keyId); metrics.providerError(route.providerSlug, 'auth'); }
    else if (upstream.status >= 500)                              { await reportServerFailure(keyId, route.isProbe); metrics.providerError(route.providerSlug, 'server'); }
    refund();
    observe(upstream.status >= 500 || upstream.status === 429 || upstream.status === 401 || upstream.status === 403 ? 'upstream_error' : 'client_error');
    return reply.code(upstream.status).send(errText);
  }

  // Read the body under a timer — parsed as JSON, or as raw bytes for a binary modality
  // (audio). A binary response is passed straight through; only its size is our concern.
  let data: Record<string, unknown> = {};
  let binary: Buffer | null = null;
  const bodyTimer = setTimeout(() => controller.abort(), UPSTREAM_BODY_MS);
  try {
    if (responseMode === 'binary') binary = Buffer.from(await upstream.arrayBuffer());
    else                          data   = await upstream.json() as Record<string, unknown>;
  } catch {
    clearTimeout(bodyTimer); refund(); observe('upstream_error');
    return reply.code(504).send({ error: 'Upstream response timed out or was malformed.' });
  }
  clearTimeout(bodyTimer);

  // Clean success: close the breaker (no sticky — these are not conversational).
  void reportSuccess(keyId, route.isProbe).catch(() => {});
  observe('success');

  const usage = {
    sessionId: `${capability}-${Date.now()}`, modelId: route.modelId ?? route.modelString, modelName: route.modelString,
    provider: route.providerSlug, nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd,
    latencyMs: Date.now() - t0,
  };
  if (billing) {
    // Non-token modality (image, speech): bill per unit, not per token. No admission
    // tokens are consumed, so the reserve is refunded in full; token metrics are left
    // untouched. A binary response carries no usage block — bill from the request.
    const quantity = billing.quantityFromResponse?.(data) ?? billing.quantityFromRequest?.(body) ?? 0;
    void reconcileTpm(keyId, reserveTokens, 0).catch(() => {});
    void recordTokenUsage({ ...usage, inputTokens: 0, outputTokens: 0, unit: billing.unit, quantity }).catch(() => {});
  } else {
    const { input, output } = extractTokenUsage(data);
    metrics.addTokens(input, output);
    void reconcileTpm(keyId, reserveTokens, input + output).catch(() => {});
    void recordTokenUsage({ ...usage, inputTokens: input, outputTokens: output }).catch(() => {});
  }

  reply.header('X-Nexus-Model', route.modelString);
  reply.header('X-Nexus-Provider', route.providerSlug);
  reply.header('X-Nexus-Tier', route.tier);
  if (binary) {
    reply.header('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
    return reply.code(200).send(binary);
  }
  return reply.code(200).send(data);
}
