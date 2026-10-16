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

import { getCacheConfig } from '../cache.service';
import { isCacheable, messagesCacheKey, responseCacheKey, getCached, toCompletionJson } from '../../lib/responseCache';
import * as metrics from '../../lib/metrics';
import type { RoutingScope } from '../../lib/scope';
import { observe, recordUsage, type ProxyRun } from './run';
import { openEventStream, toSingleSseChunk } from './sse';
import { answered, proceed, type Stage } from './types';

// ── Response cache (Phase 4.5) ────────────────────────────────────────────────
// Exact-match, checked BEFORE routing. A hit is replayed straight from Redis (streamed if the
// client asked), skipping the provider entirely; only a miss falls through to routing.

export interface CacheMiss {
  cacheCfg:      Awaited<ReturnType<typeof getCacheConfig>>;
  /** Where to store the answer once it succeeds; null when this request must not be cached. */
  cacheStoreKey: string | null;
}

export async function lookUpResponseCache(
  run: ProxyRun, scope: RoutingScope, pinnedModelId: string | null, isStream: boolean,
  /** An Anthropic Messages request's own body, which keys it instead of its translation. */
  messagesBody?: Record<string, unknown>,
): Promise<Stage<CacheMiss>> {
  const { body, reply, reqHeaders, trace, team, teamKeyId, t0 } = run;
  const cacheCfg    = await getCacheConfig();
  const cacheBypassed = reqHeaders['x-nexus-cache-bypass'] === '1';
  let cacheStoreKey: string | null = null;
  // Told apart deliberately: "the operator switched the cache off" and "this request could never
  // be cached" look identical from outside and are different answers to "why was nothing reused?".
  if (trace) trace.cache = cacheBypassed ? 'bypassed' : !cacheCfg.enabled ? 'disabled' : isCacheable(body) ? 'miss' : 'not-cacheable';
  if (!cacheBypassed && cacheCfg.enabled && isCacheable(body)) {
    // The pinned model is part of the identity: two models answering one prompt are two
    // responses, and sharing an entry between them would replay the wrong one silently.
    const key = messagesBody
      ? messagesCacheKey(messagesBody, scope.namespace, pinnedModelId)
      : responseCacheKey(body, scope.namespace, pinnedModelId);
    const hit = await getCached(key);
    if (hit) {
      metrics.responseCache('hit');
      if (trace) {
        trace.cache      = 'hit';
        trace.cachedFrom = { provider: hit.provider, modelString: hit.model };
        trace.usage      = {
          inputTokens: hit.promptTokens, outputTokens: hit.completionTokens,
          estimatedUsd: null, savedUsd: null,
        };
      }
      observe(run, 'success');
      // A cache hit is a $0 provider call, still attributed to the team so cost
      // and analytics numbers stay honest.
      await recordUsage(run, {
        sessionId: `cache-${Date.now()}`, modelId: hit.model, modelName: hit.model, provider: hit.provider,
        inputTokens: hit.promptTokens, outputTokens: hit.completionTokens,
        nexusTeamKeyId: teamKeyId, teamId: team?.id, teamBudgetPeriod: team?.budgetPeriod, teamBudgetUsd: team?.budgetUsd,
        cached: true, latencyMs: Date.now() - t0,
      });
      const completion = toCompletionJson(hit);
      const hitHeaders = { 'X-Nexus-Model': hit.model, 'X-Nexus-Provider': hit.provider, 'X-Nexus-Cache': 'hit' };
      if (isStream) {
        openEventStream(reply, hitHeaders);
        reply.raw.write(toSingleSseChunk(completion));
        reply.raw.end();
        return answered(undefined);
      }
      for (const [k, v] of Object.entries(hitHeaders)) reply.header(k, v);
      return answered(reply.code(200).send(completion));
    }
    metrics.responseCache('miss');
    cacheStoreKey = key; // populate the cache from the response once it succeeds
  }
  return proceed({ cacheCfg, cacheStoreKey });
}
