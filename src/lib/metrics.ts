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

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { prisma } from './prisma';

// ── Prometheus metrics ────────────────────────────────────────────────────────
// A scrapeable /metrics endpoint. Counters/histograms are updated on the request
// path (cheap, in-memory); pool gauges are refreshed per scrape from the DB. The
// endpoint is auth-guarded (see the route) — it exposes operational shape, not
// secrets, but is not world-readable the way /health is.

export const registry = new Registry();
registry.setDefaultLabels({ app: 'alayra-nexus' });
// Standard process/runtime metrics (cpu, memory, event-loop lag, gc).
collectDefaultMetrics({ register: registry });

const requestsTotal = new Counter({
  name: 'nexus_requests_total',
  help: 'Proxy requests by outcome and tier.',
  labelNames: ['outcome', 'tier'],
  registers: [registry],
});

const requestDuration = new Histogram({
  name: 'nexus_request_duration_seconds',
  help: 'End-to-end proxy request duration.',
  labelNames: ['outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

const upstreamTtfb = new Histogram({
  name: 'nexus_upstream_ttfb_seconds',
  help: 'Time from dispatching the upstream request to receiving response headers.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

const tokensTotal = new Counter({
  name: 'nexus_tokens_total',
  help: 'Tokens processed, by direction.',
  labelNames: ['direction'],
  registers: [registry],
});

const providerRequests = new Counter({
  name: 'nexus_provider_requests_total',
  help: 'Upstream requests dispatched, by provider.',
  labelNames: ['provider'],
  registers: [registry],
});

const providerErrors = new Counter({
  name: 'nexus_provider_errors_total',
  help: 'Upstream failures, by provider and kind (rate_limit | auth | server | timeout).',
  labelNames: ['provider', 'kind'],
  registers: [registry],
});

const cacheHits = new Counter({
  name: 'nexus_cache_hits_total',
  help: 'Requests routed to their sticky (prompt-cache-affine) key.',
  registers: [registry],
});

const keysGauge = new Gauge({
  name: 'nexus_keys',
  help: 'Pool key count by live state (active | cooling | banned).',
  labelNames: ['state'],
  registers: [registry],
});

const providersGauge = new Gauge({
  name: 'nexus_providers',
  help: 'Active provider pools.',
  registers: [registry],
});

const responseCacheTotal = new Counter({
  name: 'nexus_response_cache_total',
  help: 'Response-cache lookups by result (hit | miss | store).',
  labelNames: ['result'],
  registers: [registry],
});

const byokRequestsTotal = new Counter({
  name: 'nexus_byok_requests_total',
  help: 'Requests from teams that own provider keys, by how they were served ' +
        '(own | fallback | isolated_block).',
  labelNames: ['result'],
  registers: [registry],
});

const adminLoginTotal = new Counter({
  name: 'nexus_admin_login_total',
  help: 'Admin sign-in attempts by outcome (success | invalid | totp_required | locked_out).',
  labelNames: ['result'],
  registers: [registry],
});

// ── Recording helpers (called from the request path) ──────────────────────────

export type RequestOutcome =
  | 'success' | 'client_error' | 'blocked' | 'no_capacity'
  | 'upstream_error' | 'ssrf_blocked' | 'budget_blocked';

export function observeRequest(outcome: RequestOutcome, tier: string | undefined, seconds: number): void {
  requestsTotal.inc({ outcome, tier: tier ?? 'none' });
  requestDuration.observe({ outcome }, seconds);
}

export function observeTtfb(seconds: number): void { upstreamTtfb.observe(seconds); }

export function addTokens(input: number, output: number): void {
  if (input  > 0) tokensTotal.inc({ direction: 'input'  }, input);
  if (output > 0) tokensTotal.inc({ direction: 'output' }, output);
}

export function providerRequest(provider: string): void { providerRequests.inc({ provider }); }
export function providerError(provider: string, kind: 'rate_limit' | 'auth' | 'server' | 'timeout'): void {
  providerErrors.inc({ provider, kind });
}
export function cacheHit(): void { cacheHits.inc(); }
export function responseCache(result: 'hit' | 'miss' | 'store'): void { responseCacheTotal.inc({ result }); }

/**
 * BYOK outcome for a team that owns keys. `own` = served by the team's own key,
 * `fallback` = own keys exhausted and the shared pool served it, `isolated_block` =
 * own keys exhausted with fall-back disabled (the request was refused). A sustained
 * `fallback` rate means a team is under-provisioned on its own credentials.
 */
export function byokRequest(result: 'own' | 'fallback' | 'isolated_block'): void {
  byokRequestsTotal.inc({ result });
}

/**
 * Admin sign-in outcome. A rising `invalid` or `locked_out` rate is the signal that
 * someone is guessing the admin password.
 */
export function adminLogin(result: 'success' | 'invalid' | 'totp_required' | 'locked_out'): void {
  adminLoginTotal.inc({ result });
}

// Refresh pool gauges from the DB. Called per scrape; a scrape is infrequent, so a
// couple of lightweight queries here is fine, and it keeps utilization current.
export async function refreshPoolGauges(): Promise<void> {
  try {
    const now  = Date.now();
    const keys = await prisma.nexusKey.findMany({ select: { status: true, coolingUntil: true } });
    let active = 0, cooling = 0, banned = 0;
    for (const k of keys) {
      if (k.status === 'banned') banned++;
      else if (k.status === 'cooling' || (k.coolingUntil && k.coolingUntil.getTime() > now)) cooling++;
      else active++;
    }
    keysGauge.set({ state: 'active' },  active);
    keysGauge.set({ state: 'cooling' }, cooling);
    keysGauge.set({ state: 'banned' },  banned);
    providersGauge.set(await prisma.nexusProvider.count({ where: { isActive: true } }));
  } catch { /* leave last-known values on a DB hiccup rather than error the scrape */ }
}

export async function metricsText(): Promise<string> {
  await refreshPoolGauges();
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
