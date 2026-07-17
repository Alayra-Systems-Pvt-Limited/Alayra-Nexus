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
import { discoverBestPool, getNextCooldownSeconds, reportSuccess, reportServerFailure, reportRateLimit, reportAuthFailure, reportTierExhausted } from './nexus.service';
import { recordTokenUsage, recordOutcome } from './token.service';
import { computeReserve, countMessageTokens, countTokens } from '../lib/tokenizer';
import { reconcileTpm }              from '../lib/admission';
import { sessionHash, setStickyKeyId } from '../lib/sticky';
import { stripTrailingSlash, assertSafeUrl } from '../lib/url';
import { safeFetch }                 from '../lib/safeFetch';
import { withExtraHeaders, providerAuthHeader } from '../lib/providerHeaders';
import { getSsrfPolicy }              from './ssrf.service';
import { getGuardrailConfig }         from './guardrails.service';
import { evaluateMessages, evaluateText, type CompiledRule } from '../lib/guardrails';
import * as metrics                   from '../lib/metrics';
import { startUpstreamSpan, SpanStatusCode } from '../lib/tracing';
import { checkTeamBudget, type BudgetPeriod, type OverBudgetAction } from './budget.service';
import { getCacheConfig }              from './cache.service';
import { isCacheable, responseCacheKey, getCached, setCached, toCompletionJson, buildFromCompletion, buildFromStream } from '../lib/responseCache';
import { resolveRequestScope }         from './byok.service';
import { isByok, isIsolated }          from '../lib/scope';

export interface TeamContext {
  id:           string;
  budgetUsd:    number | null;
  budgetPeriod: string;
  byokFallback?: boolean;
  /** Preferred routing tier (Phase 8). null = no preference; routing uses the normal tier order. */
  assignedTier?: string | null;
  /** What happens at the budget cap (Phase 7.10): "block" | "notify" | "downgrade". Defaults to block. */
  overBudgetAction?: string;
}

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

export class ProxyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Output tokens to reserve when the caller does not set max_tokens. Reconciliation
// corrects the reservation to real usage once the response completes.
const DEFAULT_MAX_TOKENS_RESERVE = parseInt(process.env.NEXUS_DEFAULT_MAX_TOKENS ?? '2048', 10);
// Time to first byte: upstream must return response headers within this window.
const UPSTREAM_TTFT_MS = parseInt(process.env.UPSTREAM_TTFT_MS ?? '20000', 10);
// Non-streaming: full response body must be read within this window.
const UPSTREAM_BODY_MS = parseInt(process.env.UPSTREAM_BODY_MS ?? '60000', 10);
// Streaming: maximum gap allowed between two chunks (an idle/hung stream is aborted;
// legitimate long streams keep running as long as chunks keep arriving).
const STREAM_IDLE_MS   = parseInt(process.env.UPSTREAM_STREAM_IDLE_MS ?? '30000', 10);

function parseUsageFromSSE(collected: string): { input: number; output: number } | null {
  const lines = collected.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (json === '[DONE]') continue;
    try {
      const parsed = JSON.parse(json) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (parsed.usage?.prompt_tokens !== undefined) {
        return { input: parsed.usage.prompt_tokens ?? 0, output: parsed.usage.completion_tokens ?? 0 };
      }
    } catch { /* skip */ }
  }
  return null;
}

function estimateDeltaTokens(collected: string): number {
  const matches = collected.match(/"delta"\s*:\s*\{[^}]*"content"\s*:\s*"([^"]*)"/g) ?? [];
  const content = matches.map(m => { try { return JSON.parse(`{${m}}`).delta?.content ?? ''; } catch { return ''; } }).join('');
  return Math.max(1, countTokens(content));
}

/** Does the rule set contain any rule that inspects the model's output? */
function hasOutputRules(rules: CompiledRule[]): boolean {
  return rules.some((r) => (r.appliesTo ?? 'both') !== 'input');
}

/**
 * Apply output rules to a non-streaming completion in place. A block replaces the
 * choice's content with a withheld notice; a redact masks matches. Returns the
 * names of rules that fired.
 */
function applyOutputGuardrails(data: Record<string, unknown>, rules: CompiledRule[]): string[] {
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

/** Serialize one assistant message as a single OpenAI-style streaming chunk + DONE. */
function toSingleSseChunk(data: Record<string, unknown>): string {
  const first  = Array.isArray(data.choices) ? data.choices[0] as { message?: { content?: unknown }; finish_reason?: string } : undefined;
  const content = first && typeof first.message?.content === 'string' ? first.message.content : '';
  const chunk = {
    id:      typeof data.id === 'string' ? data.id : `chatcmpl-${Date.now()}`,
    object:  'chat.completion.chunk',
    created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    model:   typeof data.model === 'string' ? data.model : '',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: first?.finish_reason ?? 'stop' }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/** Fire-and-forget: persist a non-streaming completion to the response cache. */
function storeInCache(key: string | null, data: Record<string, unknown>, provider: string, ttl: number): void {
  if (!key) return;
  const entry = buildFromCompletion(data, provider); // null for tool-call-only / empty responses
  if (!entry) return;
  metrics.responseCache('store');
  void setCached(key, entry, ttl).catch(() => {});
}

/** Fire-and-forget: persist a streamed completion, assembled from its buffer. */
function storeStreamInCache(key: string | null, collected: string, model: string, provider: string, promptTokens: number, completionTokens: number, ttl: number): void {
  if (!key) return;
  const entry = buildFromStream(collected, model, provider, promptTokens, completionTokens);
  if (!entry.content) return; // empty / tool-call-only stream — nothing to replay
  metrics.responseCache('store');
  void setCached(key, entry, ttl).catch(() => {});
}

export async function handleProxy(
  body: CompletionsBody,
  reply: FastifyReply,
  teamKeyId?: string,
  reqHeaders: Record<string, unknown> = {},
  team?: TeamContext,
): Promise<FastifyReply | void> {
  // Metrics: measure the whole request and record its outcome at each exit.
  const t0 = Date.now();
  let tier: string | undefined = undefined; // set once a route is chosen
  let routeProvider: string | null = null;  // ditto — a request that fails before routing has neither
  let routeModel:    string | null = null;
  // Every exit calls this exactly once, which makes it the one honest seam for persisting an
  // outcome. Failures are written here; a success is written by recordTokenUsage (which also
  // carries the tokens, cost, and cache saving), so recording it here too would double-count.
  //
  // `persist: false` is for the one path that fails yet still has real token usage to record — a
  // stream that dies mid-flight. There, recordTokenUsage writes the single row and stamps the
  // failed outcome on it itself; writing a second row here would both double-count the request and
  // book its tokens as a success.
  const observe = (outcome: metrics.RequestOutcome, persist = true) => {
    const elapsed = Date.now() - t0;
    metrics.observeRequest(outcome, tier, elapsed / 1000);
    if (outcome !== 'success' && persist) {
      void recordOutcome({
        outcome, latencyMs: elapsed, provider: routeProvider, modelName: routeModel, nexusTeamKeyId: teamKeyId,
      }).catch(() => {});
    }
  };

  const modelField = (body.model ?? '').trim().toLowerCase();
  // Canonical id is `alayra-nexus-1`; `kinetic-nexus-1` and `nexus` stay as silent
  // backward-compatible aliases so existing integrations keep routing.
  if (modelField && modelField !== 'alayra-nexus-1' && modelField !== 'kinetic-nexus-1' && modelField !== 'nexus') {
    observe('client_error');
    return reply.code(400).send({
      error: `Invalid model "${body.model}". Use model: "alayra-nexus-1" — Alayra Nexus routes automatically.`,
    });
  }

  // ── Team budget gate — enforced before any provider work happens. Requests
  // already in flight when the cap is crossed may overshoot by their own cost
  // (cost is unknowable up front on a streaming gateway); see budget.service.
  // Over-budget behaviour is per-team (Phase 7.10): "block" refuses here, "notify"
  // admits silently, and "downgrade" admits but pins routing to the fast tier below.
  let overBudgetDowngrade = false;
  if (team && team.budgetUsd != null) {
    const budget = await checkTeamBudget(team.id, team.budgetUsd, team.budgetPeriod as BudgetPeriod, (team.overBudgetAction ?? 'block') as OverBudgetAction);
    if (!budget.allowed) {
      observe('budget_blocked');
      return reply
        .code(429)
        .header('Retry-After', String(budget.retryAfterSeconds))
        .send({
          error: `Team budget exhausted: $${budget.spendUsd.toFixed(4)} of $${team.budgetUsd} used this ${team.budgetPeriod === 'daily' ? 'day' : team.budgetPeriod === 'weekly' ? 'week' : 'month'}. Resets in ${budget.retryAfterSeconds}s.`,
          spendUsd:   budget.spendUsd,
          budgetUsd:  team.budgetUsd,
          retryAfter: budget.retryAfterSeconds,
        });
    }
    overBudgetDowngrade = budget.downgrade;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;

  // ── Guardrails (input side) — inspect/redact/reject before forwarding ──
  const guard = await getGuardrailConfig();
  const guardActive = guard.enabled && guard.compiled.length > 0;
  const guardHeaders: Record<string, string> = {};
  let effectiveMessages = messages;

  if (guardActive) {
    guardHeaders['X-Nexus-Guardrails'] = 'on';
    const verdict = evaluateMessages(messages, guard.compiled);
    if (verdict.decision === 'block') {
      observe('blocked');
      return reply.code(400).send({ error: 'Request blocked by content guardrails.', guardrails: verdict.matched });
    }
    if (verdict.decision === 'redact') {
      effectiveMessages = verdict.messages;
      guardHeaders['X-Nexus-Guardrails-Input'] = `redacted:${verdict.matched.join(',')}`;
    }
  }

  const outputFiltering = guardActive && hasOutputRules(guard.compiled);
  // Buffered-safe mode: the only way to filter a streamed response is to collect it
  // first, which trades away the zero-buffer TTFT win. We never do that silently —
  // it happens only when the operator has explicitly opted in.
  const bufferStream = isStream && outputFiltering && guard.bufferedSafe;
  if (isStream && outputFiltering && !guard.bufferedSafe) {
    guardHeaders['X-Nexus-Guardrails-Output'] = 'skipped-streaming';
  }

  // ── BYOK scope (Phase 5.5) — resolved once, then threaded into BOTH the response
  // cache namespace and pool discovery. Deriving them from one value is what keeps a
  // response paid for by one team's private key out of another scope's cache.
  const scope = await resolveRequestScope(team);

  // ── Response cache (Phase 4.5) — exact-match, checked BEFORE routing. A hit is
  // replayed straight from Redis (streamed if the client asked), skipping the
  // provider entirely; only a miss falls through to routing.
  const cacheCfg    = await getCacheConfig();
  let cacheStoreKey: string | null = null;
  if (cacheCfg.enabled && isCacheable(body)) {
    const key = responseCacheKey(body, scope.namespace);
    const hit = await getCached(key);
    if (hit) {
      metrics.responseCache('hit');
      observe('success');
      // A cache hit is a $0 provider call, still attributed to the team so cost
      // and analytics numbers stay honest.
      void recordTokenUsage({
        sessionId: `cache-${Date.now()}`, modelId: hit.model, modelName: hit.model, provider: hit.provider,
        inputTokens: hit.promptTokens, outputTokens: hit.completionTokens,
        nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd,
        cached: true, latencyMs: Date.now() - t0,
      }).catch(() => {});
      const completion = toCompletionJson(hit);
      const hitHeaders = { 'X-Nexus-Model': hit.model, 'X-Nexus-Provider': hit.provider, 'X-Nexus-Cache': 'hit' };
      if (isStream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type':      'text/event-stream; charset=utf-8',
          'Cache-Control':     'no-cache, no-transform',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
          ...hitHeaders,
        });
        reply.raw.write(toSingleSseChunk(completion));
        reply.raw.end();
        return;
      }
      for (const [k, v] of Object.entries(hitHeaders)) reply.header(k, v);
      return reply.code(200).send(completion);
    }
    metrics.responseCache('miss');
    cacheStoreKey = key; // populate the cache from the response once it succeeds
  }

  const reserve  = computeReserve(effectiveMessages, body.max_tokens, DEFAULT_MAX_TOKENS_RESERVE);
  // Cache-aware sticky routing: pin a continuing conversation to its last key.
  const session  = sessionHash({ messages, user: body.user }, reqHeaders);
  // OpenAI-standard end-user id, used to enforce each key's Max Users cap. Absent → no per-user
  // enforcement (see admitUser).
  const userId   = typeof body.user === 'string' ? body.user : null;

  // An over-budget team on the "downgrade" action is routed to the fast (cheapest) tier regardless of
  // its normal preference, so it keeps working at the lowest cost rather than being cut off.
  const preferredTier = overBudgetDowngrade ? 'fast' : (team?.assignedTier ?? null);
  const route = await discoverBestPool(reserve, session, scope, 'chat', userId, preferredTier);
  if (!route) {
    observe('no_capacity');
    const isolated = isIsolated(scope);
    if (isolated) metrics.byokRequest('isolated_block');
    // Operator alert (Phase 6.4b): the gateway is refusing chat traffic. Fire-and-forget,
    // coalesced to one message per window so a sustained outage does not flood.
    void reportTierExhausted('chat', isolated).catch(() => {});
    const retryAfter = await getNextCooldownSeconds();
    return reply
      .code(503)
      .header('Retry-After', String(retryAfter))
      .send({
        // An isolated team must be told the truth: the shared pool was never an
        // option, so "add more provider keys" would be misleading advice.
        error: isolated
          ? `Your team's own provider keys are all rate-limited or unavailable, and fall-back to the shared pool is disabled for this team. Retry in ${retryAfter}s or add more keys to your team.`
          : `All API keys are currently rate-limited. Retry in ${retryAfter}s or add more provider keys.`,
        retryAfter,
      });
  }

  // Route chosen: record provider dispatch and (if applicable) a prompt-cache hit.
  tier          = route.tier;
  routeProvider = route.providerSlug;
  routeModel    = route.modelString;
  metrics.providerRequest(route.providerSlug);
  if (route.sticky) metrics.cacheHit();
  // Only a key-owning team can produce a BYOK outcome; pooled callers are not counted.
  if (isByok(scope)) metrics.byokRequest(route.byok ? 'own' : 'fallback');

  const keyId = route.keyId;
  // Release the full token reservation for a request that did not (fully) run.
  // RPM stays consumed on purpose — the request was attempted against the provider.
  const refundReservation = () => { void reconcileTpm(keyId, reserve, 0).catch(() => {}); };

  // Defense in depth: base URLs are SSRF-validated when a provider is created, but
  // re-check on the hot path so a route can never reach a blocked internal host.
  try {
    assertSafeUrl(stripTrailingSlash(route.baseUrl), await getSsrfPolicy());
  } catch (err) {
    refundReservation();
    observe('ssrf_blocked');
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'Upstream blocked by SSRF policy.' });
  }

  const upstreamUrl  = `${stripTrailingSlash(route.baseUrl)}/chat/completions`;
  // Forward the (possibly redacted) messages. In buffered-safe mode we request a
  // non-streamed response from upstream so we can inspect it before replaying it.
  const upstreamBody = { ...body, messages: effectiveMessages, model: route.modelString, ...(bufferStream ? { stream: false } : {}) };
  const headers: Record<string, string> = withExtraHeaders(route.extraHeaders, {
    'Content-Type': 'application/json',
    ...providerAuthHeader(route.authHeader, route.authPrefix, route.decryptedKey),
  });
  const sessionId = `proxy-${Date.now()}`;

  // A single controller governs the whole upstream call. A time-to-first-byte
  // timer aborts if response headers never arrive; it is cleared once they do.
  const controller = new AbortController();
  let ttftTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), UPSTREAM_TTFT_MS);

  // OTel: span for the gateway → provider call (no-op unless an SDK is attached).
  const tFetch = Date.now();
  const span = startUpstreamSpan({ 'nexus.provider': route.providerSlug, 'nexus.tier': route.tier, 'nexus.model': route.modelString });

  let upstream: Response;
  try {
    upstream = await safeFetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: controller.signal });
  } catch (err) {
    if (ttftTimer) clearTimeout(ttftTimer);
    refundReservation();
    // A timeout/connection failure is a server-side fault: feed the breaker.
    await reportServerFailure(keyId, route.isProbe);
    metrics.providerError(route.providerSlug, 'timeout');
    span.recordException(err as Error); span.setStatus({ code: SpanStatusCode.ERROR }); span.end();
    observe('upstream_error');
    const aborted = err instanceof Error && err.name === 'AbortError';
    return reply.code(504).send({ error: aborted ? 'Upstream timed out before responding.' : 'Upstream connection failed.' });
  }
  if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = null; }
  metrics.observeTtfb((Date.now() - tFetch) / 1000);
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
    // 4xx (other than 429) is the caller's bad request; 429/auth/5xx is an upstream fault.
    observe(upstream.status >= 500 || upstream.status === 429 || upstream.status === 401 || upstream.status === 403 ? 'upstream_error' : 'client_error');
    return reply.code(upstream.status).send(errText);
  }
  span.end(); // upstream responded OK

  const nexusHeaders: Record<string, string> = {
    'X-Nexus-Model':          route.modelString,
    'X-Nexus-Provider':       route.providerSlug,
    'X-Nexus-Tier':           route.tier,
    ...(route.wasDowngrade ? { 'X-Nexus-Tier-Downgrade': 'true' } : {}),
    ...(route.sticky        ? { 'X-Nexus-Sticky': 'true' } : {}),
    ...(route.byok          ? { 'X-Nexus-BYOK': 'true' } : {}),
    ...(cacheStoreKey       ? { 'X-Nexus-Cache': 'miss' } : {}),
    ...guardHeaders,
  };
  // On a healthy response, close the breaker and pin this session to the key so
  // follow-up turns reuse the provider's prompt cache.
  const onHealthy = () => {
    void reportSuccess(keyId, route.isProbe).catch(() => {});
    if (session) void setStickyKeyId(session, keyId).catch(() => {});
  };

  // ── Buffered-safe streaming: collect the full (non-streamed) upstream response,
  // apply output guardrails, then replay it to the client as a single SSE chunk.
  if (bufferStream) {
    let data: Record<string, unknown>;
    const bodyTimer = setTimeout(() => controller.abort(), UPSTREAM_BODY_MS);
    try {
      data = await upstream.json() as Record<string, unknown>;
    } catch {
      clearTimeout(bodyTimer);
      refundReservation();
      observe('upstream_error');
      return reply.code(504).send({ error: 'Upstream response timed out or was malformed.' });
    }
    clearTimeout(bodyTimer);
    onHealthy();

    const matched = applyOutputGuardrails(data, guard.compiled);
    const outHeaders = { ...nexusHeaders, 'X-Nexus-Guardrails-Output': matched.length ? `buffered:${matched.join(',')}` : 'buffered' };

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':       'text/event-stream; charset=utf-8',
      'Cache-Control':      'no-cache, no-transform',
      'Connection':         'keep-alive',
      'X-Accel-Buffering':  'no',
      ...outHeaders,
    });
    reply.raw.write(toSingleSseChunk(data));
    reply.raw.end();

    const usageObj     = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const inputTokens  = usageObj?.prompt_tokens    ?? countMessageTokens(effectiveMessages);
    const outputTokens = usageObj?.completion_tokens ?? 1;
    observe('success'); metrics.addTokens(inputTokens, outputTokens);
    storeInCache(cacheStoreKey, data, route.providerSlug, cacheCfg.ttlSeconds);
    void reconcileTpm(keyId, reserve, inputTokens + outputTokens).catch(() => {});
    void recordTokenUsage({ sessionId, modelId: route.modelId ?? route.modelString, modelName: route.modelString, provider: route.providerSlug, inputTokens, outputTokens, nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd, latencyMs: Date.now() - t0 }).catch(() => {});
    return;
  }

  if (isStream && upstream.body) {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':          'text/event-stream; charset=utf-8',
      'Cache-Control':         'no-cache, no-transform',
      'Connection':            'keep-alive',
      'X-Accel-Buffering':    'no',
      ...nexusHeaders,
    });

    const reader    = upstream.body.getReader();
    const decoder   = new TextDecoder();
    let collected   = '';
    let streamFailed = false;
    // Idle guard: abort if the gap between chunks exceeds STREAM_IDLE_MS.
    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), STREAM_IDLE_MS);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
        collected += decoder.decode(value, { stream: true });
        reply.raw.write(value);
      }
    } catch { streamFailed = true; /* aborted (idle timeout) or upstream error mid-stream — flush what we have */ }
    finally {
      clearTimeout(idleTimer);
      reply.raw.end();
    }

    // A stream that connected (200 headers) but hung/aborted mid-flight is a
    // server-side fault; a clean completion closes the breaker and sticks. Either way it delivered
    // tokens the provider will bill for, so recordTokenUsage below writes the one row and carries
    // the real outcome — hence persist: false here (see the observe comment).
    if (streamFailed) { void reportServerFailure(keyId, route.isProbe).catch(() => {}); metrics.providerError(route.providerSlug, 'server'); observe('upstream_error', false); }
    else { onHealthy(); observe('success'); }

    const usage        = parseUsageFromSSE(collected);
    const inputTokens  = usage?.input  ?? countMessageTokens(effectiveMessages);
    const outputTokens = usage?.output ?? estimateDeltaTokens(collected);
    metrics.addTokens(inputTokens, outputTokens);
    // Only cache a cleanly-completed stream; reuse the buffer already collected.
    if (!streamFailed) storeStreamInCache(cacheStoreKey, collected, route.modelString, route.providerSlug, inputTokens, outputTokens, cacheCfg.ttlSeconds);
    void reconcileTpm(keyId, reserve, inputTokens + outputTokens).catch(() => {});
    void recordTokenUsage({ sessionId, modelId: route.modelId ?? route.modelString, modelName: route.modelString, provider: route.providerSlug, inputTokens, outputTokens, nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd, latencyMs: Date.now() - t0, outcome: streamFailed ? 'upstream_error' : 'success' }).catch(() => {});
    return;
  }

  // Non-streaming: bound the body read with its own timer.
  let data: Record<string, unknown>;
  const bodyTimer = setTimeout(() => controller.abort(), UPSTREAM_BODY_MS);
  try {
    data = await upstream.json() as Record<string, unknown>;
  } catch {
    clearTimeout(bodyTimer);
    refundReservation();
    observe('upstream_error');
    return reply.code(504).send({ error: 'Upstream response timed out or was malformed.' });
  }
  clearTimeout(bodyTimer);

  onHealthy();

  // Guardrails (output side) — safe here because the full body is already buffered.
  if (outputFiltering) {
    const matched = applyOutputGuardrails(data, guard.compiled);
    if (matched.length) nexusHeaders['X-Nexus-Guardrails-Output'] = `applied:${matched.join(',')}`;
  }

  const usageObj     = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const inputTokens  = usageObj?.prompt_tokens     ?? countMessageTokens(effectiveMessages);
  const outputTokens = usageObj?.completion_tokens  ?? 1;
  observe('success'); metrics.addTokens(inputTokens, outputTokens);
  storeInCache(cacheStoreKey, data, route.providerSlug, cacheCfg.ttlSeconds); // cache the post-guardrails response
  void reconcileTpm(keyId, reserve, inputTokens + outputTokens).catch(() => {});
  void recordTokenUsage({ sessionId, modelId: route.modelId ?? route.modelString, modelName: route.modelString, provider: route.providerSlug, inputTokens, outputTokens, nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd, latencyMs: Date.now() - t0 }).catch(() => {});

  for (const [k, v] of Object.entries(nexusHeaders)) reply.header(k, v);
  return reply.code(200).send(data);
}
