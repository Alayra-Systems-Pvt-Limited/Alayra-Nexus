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

// The active provider pools, read once instead of twice per request.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
//
// A CPU profile of the gateway under load (scripts/bench/profile.ts) found that our own
// application code accounts for roughly 4% of the CPU a chat completion costs, and the database
// layer for most of the rest. The reason was not a slow query; it was four of them per request,
// two of which were this table:
//
//   activeProviderSlugs()  — which providers have a pool at all
//   sweepModels()          — the pools for the candidate models, in creation order
//
// Provider rows change when an operator adds, edits or removes a pool. They do not change between
// two consecutive chat completions, so asking twice per request is asking a question whose answer
// is already known.
//
// ── Why a projection rather than the row ──────────────────────────────────────────────────────
//
// Only the scalar columns routing actually reads are cached. That keeps the payload small, but the
// real reason is correctness: this value round-trips through JSON, and `JSON.parse` turns a
// `DateTime` column into a string while TypeScript goes on believing it is a `Date`. Code that then
// called `.getTime()` would compile and throw at runtime. Selecting only scalars makes that class
// of bug unrepresentable rather than merely absent.
//
// ── Staleness ─────────────────────────────────────────────────────────────────────────────────
//
// Every mutation path invalidates explicitly (see providers.routes.ts), and because invalidation is
// a `del` against the shared KV, a scaled deployment invalidates every instance, not just the one
// that served the write. The TTL is a backstop for the paths that replace rows wholesale without
// going through those routes — a restore, or a migration to Postgres — matching how the model
// registry has always behaved.

import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { PROVIDER_CACHE_KEY } from '../lib/registryCacheKey';
import { TtlMemo } from '../lib/ttlMemo';

/**
 * Exactly the columns routing reads. Structurally identical to nexus.service's `ProviderRow`,
 * which is what makes this a drop-in for the queries it replaces.
 */
export interface CachedProvider {
  id: string;
  baseUrl: string | null;
  provider: string;
  authHeader: string;
  authPrefix: string | null;
  tier: string;
  preferredModel: string | null;
  extraHeaders: string | null;
}

const PROVIDER_SELECT = {
  id: true, baseUrl: true, provider: true, authHeader: true,
  authPrefix: true, tier: true, preferredModel: true, extraHeaders: true,
} as const;

/** Matches the model registry's cache. See the staleness note in the header. */
const TTL_SECONDS = 60;

/**
 * A few seconds in front of the Redis copy.
 *
 * Measured with `npm run bench:store-ops`: this key was fetched TWICE on every request. Free
 * against the in-process map that standalone mode uses, two network round trips against a real
 * Redis — on a value that changes when an operator edits a pool. See lib/ttlMemo.ts.
 */
const memo = new TtlMemo<CachedProvider[]>(5_000, 'PROVIDER_MEMO_TTL_MS');

/**
 * Every active pool, oldest first.
 *
 * The `createdAt` ordering is applied HERE, once, and every caller filters the result in memory.
 * That is what preserves selection order: a filter never reorders, so a caller that used to run
 * `where: { provider: { in: [...] } }, orderBy: { createdAt: 'asc' }` gets the same pools in the
 * same sequence, and routing picks the same key it always did.
 */
export async function getActiveProviders(): Promise<CachedProvider[]> {
  const local = memo.get(PROVIDER_CACHE_KEY);
  if (local !== undefined) return local;

  const cached = await redis.get(PROVIDER_CACHE_KEY);
  if (cached) {
    try {
      const rows = JSON.parse(cached) as CachedProvider[];
      memo.set(PROVIDER_CACHE_KEY, rows);
      return rows;
    } catch { /* corrupt entry — re-read below */ }
  }

  const rows = await prisma.nexusProvider.findMany({
    where:   { isActive: true },
    orderBy: { createdAt: 'asc' },
    select:  PROVIDER_SELECT,
  });

  await redis.set(PROVIDER_CACHE_KEY, JSON.stringify(rows), 'EX', TTL_SECONDS);
  memo.set(PROVIDER_CACHE_KEY, rows);
  return rows;
}

/** Call after any write that could change which pools are active, or their routing columns. */
export async function invalidateProviderCache(): Promise<void> {
  await redis.del(PROVIDER_CACHE_KEY);
  // The shared copy is gone for every instance; this one also forgets its own, so the instance
  // that took the write is never stale about its own change.
  memo.forget();
}
