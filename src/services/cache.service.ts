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

// The cache's stats and purge live in cacheStats.service.ts (P0.5a).
