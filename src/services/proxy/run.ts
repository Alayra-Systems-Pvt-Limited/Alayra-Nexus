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
import { recordTokenUsage, recordOutcome } from '../token.service';
import * as metrics from '../../lib/metrics';
import type { RequestTrace } from '../../lib/requestTrace';
import type { TeamContext } from '../../core/context';
import type { NexusRoute } from '../nexus.service';
import type { CompletionsBody } from './types';

// ── One proxied request ───────────────────────────────────────────────────────
// Everything a stage needs to know about the request in flight, plus the three recording seams
// every exit goes through. Built once by handleProxy and handed to each stage in turn.

export interface ProxyRun {
  readonly body:       CompletionsBody;
  readonly reply:      FastifyReply;
  readonly teamKeyId?: string;
  readonly reqHeaders: Record<string, unknown>;
  readonly team?:      TeamContext;
  readonly trace?:     RequestTrace;
  /** When the request arrived; every latency figure is measured from here. */
  readonly t0:         number;
  // Set once a route is chosen — a request that fails before routing has none of them.
  tier?:         string;
  routeProvider: string | null;
  routeModel:    string | null;
  /** When the provider call started; the trace's upstream time is measured from here. */
  tFetch:        number;
}

export function createProxyRun(input: Omit<ProxyRun, 't0' | 'routeProvider' | 'routeModel' | 'tFetch'>): ProxyRun {
  return { ...input, t0: Date.now(), routeProvider: null, routeModel: null, tFetch: 0 };
}

/**
 * Record a request's outcome. Every exit calls this exactly once, which makes it the one honest
 * seam for persisting an outcome. Failures are written here; a success is written by
 * recordTokenUsage (which also carries the tokens, cost, and cache saving), so recording it here
 * too would double-count.
 *
 * `persist: false` is for the one path that fails yet still has real token usage to record — a
 * stream that dies mid-flight. There, recordTokenUsage writes the single row and stamps the
 * failed outcome on it itself; writing a second row here would both double-count the request and
 * book its tokens as a success.
 */
export function observe(run: ProxyRun, outcome: metrics.RequestOutcome, persist = true): void {
  const elapsed = Date.now() - run.t0;
  metrics.observeRequest(outcome, run.tier, elapsed / 1000);
  // The trace's outcome and total ride here rather than at each exit, because `observe` is
  // already the one place every exit passes through exactly once — which is what makes it the
  // only stamp that cannot be forgotten when a fifteenth exit is added.
  if (run.trace) { run.trace.outcome = outcome; run.trace.timing.totalMs = elapsed; }
  if (outcome !== 'success' && persist) {
    void recordOutcome({
      outcome, latencyMs: elapsed, provider: run.routeProvider, modelName: run.routeModel, nexusTeamKeyId: run.teamKeyId,
    }).catch(() => {});
  }
}

/**
 * Record what the provider actually billed, on whichever of the three success paths ran.
 *
 * Token counts only. The money is stamped separately by `recordTokenUsage`, which is the one
 * place the registry is consulted — computing a price here as well would give two figures that
 * agree until the day one of them changes. See lib/requestTrace.ts.
 */
export function stampUsage(run: ProxyRun, inputTokens: number, outputTokens: number): void {
  if (!run.trace) return;
  run.trace.usage = { inputTokens, outputTokens, estimatedUsd: null, savedUsd: null };
  run.trace.timing.upstreamMs = Date.now() - run.tFetch;
}

/**
 * Persist token usage. Ordinary traffic keeps analytics off the response path. A traced caller
 * waits only for the registry lookup that stamps the exact cost before the Playground serialises
 * its final event.
 */
export async function recordUsage(run: ProxyRun, params: Parameters<typeof recordTokenUsage>[0]): Promise<void> {
  const recording = recordTokenUsage(params, run.trace).catch(() => {});
  if (run.trace) await recording;
}

/** The usage row for a completed provider call; a stream adds its own `outcome`. */
export function routeUsage(
  run: ProxyRun, route: NexusRoute, sessionId: string, inputTokens: number, outputTokens: number,
): Parameters<typeof recordTokenUsage>[0] {
  return {
    sessionId, modelId: route.modelId ?? route.modelString, modelName: route.modelString, provider: route.providerSlug,
    inputTokens, outputTokens, nexusTeamKeyId: run.teamKeyId, teamId: run.team?.id,
    teamBudgetPeriod: run.team?.budgetPeriod, teamBudgetUsd: run.team?.budgetUsd, latencyMs: Date.now() - run.t0,
  };
}
