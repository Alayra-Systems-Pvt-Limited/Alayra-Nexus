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

import { getSetting, setSetting } from './settings.service';
import { Prisma } from '@prisma/client';
import { dual, dualQuery, type DualSql } from '../lib/dialect';
import { countKeys, deleteKeys } from '../lib/redisScan';
import { RESP_CACHE_PREFIX } from '../lib/responseCache';

// Response cache configuration, resolved from dashboard-editable settings with an
// environment seed. OFF by default: a fresh deployment caches nothing until an
// operator opts in.
//
//   CACHE_ENABLED      — 'true' to serve exact-match responses from cache
//   CACHE_TTL_SECONDS  — how long a cached response stays fresh (default 3600)

export const SETTING_ENABLED = 'CACHE_ENABLED';
export const SETTING_TTL     = 'CACHE_TTL_SECONDS';
const DEFAULT_TTL_SECONDS = 3600;

function truthy(v: string | null | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

function parseTtl(v: string | null | undefined): number {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

export interface CacheConfig { enabled: boolean; ttlSeconds: number; }

export async function getCacheConfig(): Promise<CacheConfig> {
  const [enabledS, ttlS] = await Promise.all([getSetting(SETTING_ENABLED), getSetting(SETTING_TTL)]);
  return {
    enabled:    enabledS === null ? truthy(process.env[SETTING_ENABLED]) : truthy(enabledS),
    ttlSeconds: ttlS === null ? parseTtl(process.env[SETTING_TTL]) : parseTtl(ttlS),
  };
}

export async function getCacheConfigForUI(): Promise<CacheConfig> {
  return getCacheConfig();
}

export async function setCacheConfig(enabled: boolean, ttlSeconds: number): Promise<void> {
  await Promise.all([
    setSetting(SETTING_ENABLED, enabled ? 'true' : 'false'),
    setSetting(SETTING_TTL, String(ttlSeconds > 0 ? Math.floor(ttlSeconds) : DEFAULT_TTL_SECONDS)),
  ]);
}

// ── Operational view (Phase 7.7) ──────────────────────────────────────────────
// What the Caching section shows and does: how many entries the cache holds right now, what it has
// saved lately, and a one-click purge.

const RESP_CACHE_PATTERN = `${RESP_CACHE_PREFIX}*`;
/** Savings/hit figures are scoped to a recent window: cache outcomes were only recorded from Phase
 *  7.5a onward, so an all-time view would dilute the rate with rows that never measured a hit. */
const STATS_WINDOW_DAYS = 7;

export interface CacheStats {
  config:     CacheConfig;
  /** Live count of cached responses in Redis right now. */
  entries:    number;
  windowDays: number;
  recent: {
    hits:     number;   // cache hits served in the window
    requests: number;   // successful requests in the window (the denominator for the rate)
    hitRate:  number;   // 0–1, hits over successful requests; 0 when there was no traffic
    savedUsd: number;   // what those hits would have cost had they hit a provider
  };
}

/** Cache accounting over the stats window, in both dialects. See lib/dialect.ts. */
export const CACHE_STATS = (since: Date): DualSql => dual(
  Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE "cached")::int              AS hits,
             COUNT(*) FILTER (WHERE "outcome" = 'success')::int AS successes,
             SUM("savedUsd")::float8                            AS saved
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since}`,

  Prisma.sql`
      SELECT CAST(COUNT(*) FILTER (WHERE "cached") AS REAL)              AS hits,
             CAST(COUNT(*) FILTER (WHERE "outcome" = 'success') AS REAL) AS successes,
             CAST(SUM("savedUsd") AS REAL)                               AS saved
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since}`,
);

export async function getCacheStats(): Promise<CacheStats> {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);
  const [config, entries, rows] = await Promise.all([
    getCacheConfig(),
    countKeys(RESP_CACHE_PATTERN),
    dualQuery<{ hits: number; successes: number; saved: number | null }>(CACHE_STATS(since)),
  ]);

  const r         = rows[0] ?? { hits: 0, successes: 0, saved: 0 };
  const hits      = Number(r.hits) || 0;
  const successes = Number(r.successes) || 0;
  const savedUsd  = Number(r.saved) || 0;

  return {
    config,
    entries,
    windowDays: STATS_WINDOW_DAYS,
    recent: { hits, requests: successes, hitRate: successes > 0 ? hits / successes : 0, savedUsd },
  };
}

/** Empty the response cache. Every namespace shares one prefix, so this necessarily clears the shared
 *  pool and every team's entries alike — per-team purge is impossible, the namespace lives inside the
 *  hashed key. Returns how many entries were removed. */
export async function purgeResponseCache(): Promise<{ deleted: number }> {
  return { deleted: await deleteKeys(RESP_CACHE_PATTERN) };
}
