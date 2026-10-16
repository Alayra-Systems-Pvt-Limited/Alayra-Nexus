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

// Settings, read once per process per few seconds instead of once per request.
//
// ── What this is fixing ───────────────────────────────────────────────────────────────────────
//
// Redis has always been in front of the database here, and against the in-process map that
// standalone mode uses, a read costs nothing. Against a real Redis every one of these is a network
// round trip — and a request reads a lot of them. Counted with `npm run bench:store-ops`, one chat
// completion made **31 Redis round trips, 18 of them plain GETs**, nearly all of this shape:
//
//   GUARDRAILS_ENABLED  GUARDRAILS_RULES  GUARDRAILS_BUFFERED_SAFE  CACHE_ENABLED
//   CACHE_TTL_SECONDS   SSRF_ALLOWLIST    SSRF_ALLOW_PRIVATE        ROUTING_COST_WEIGHT
//   ANONYMIZE_USAGE     AI_MODEL_REGISTRY NEXUS_API_KEY_HASH        …
//
// Every one is a value an operator edits from the dashboard. None of them changes between two
// consecutive requests. That cost is why the same gateway measures 671 requests a second on the
// standalone file and 281 against Postgres and Redis: not CPU, but sequential waiting.
//
// No CPU profile could have found this. A profiler measures CPU, and this is time spent not using
// any. It took counting the round trips to see it.
//
// ── Why a few seconds, and what it costs ──────────────────────────────────────────────────────
//
// `setSetting` writes through to Redis, so today a change made on one instance is visible to every
// other instance immediately. This memo is the one thing that changes that: another instance can go
// on serving the previous value until its own entry expires. So the window is deliberately short,
// and it is the ONLY new staleness — the writing instance updates its own memo in the same call and
// is never stale about its own change.
//
// Five seconds is chosen the same way the key-row cache's one second was: the saving comes from
// holding a value across the requests arriving while it is hot, not from holding it long. At a few
// hundred requests a second, five seconds already removes better than 99.9% of these reads, and
// every extra second after that buys a rounding error while widening the window in which two
// instances disagree about, say, whether guardrails are on.
//
// SETTING_MEMO_TTL_MS=0 disables the memo and restores a Redis round trip per read. MEMO_MAX_STALE_MS
// (lib/ttlMemo.ts) lets an expired setting be served while one background read replaces it, for at
// most that long after it was read — except the master key's hash, below.

import { coreStores } from '../core/stores';
import { redis }  from '../lib/redis';
import { TtlMemo } from '../lib/ttlMemo';

const CACHE_TTL = 300; // 5 min, in Redis

/** Per-process, and holding `null` as a real value — an unset setting is read just as often. */
const memo = new TtlMemo<string | null>(5_000, 'SETTING_MEMO_TTL_MS', 'the setting');

/**
 * Settings never served past their own window. The gateway's master key is checked against this
 * hash on every request, and a rotation is how an operator shuts out a leaked key: it must reach
 * every instance within the few seconds it always has, whatever MEMO_MAX_STALE_MS says.
 */
const NEVER_STALE = new Set(['NEXUS_API_KEY_HASH']);

export function getSetting(key: string): Promise<string | null> {
  return memo.load(key, () => readSettingFresh(key), { stale: !NEVER_STALE.has(key) });
}

/**
 * A setting read past this process's memo: the shared copy, else the database.
 *
 * For a reader that memoises what it builds from the value — the model registry is the one today.
 * Reading through this memo as well would stack the two windows, and worse: that reader writes what
 * it built back to Redis as the copy every instance reads, so an old value held here would be handed
 * to all of them for as long as that copy lives.
 */
export async function readSettingFresh(key: string): Promise<string | null> {
  const cached = await redis.get(`nexus:setting:${key}`);
  if (cached !== null) return cached === '__null__' ? null : cached;

  const value = await (await coreStores()).settings.get(key);
  // NX: only fill a copy that is still missing. A `setSetting` on any instance that landed while this
  // read was at the database wrote the newer value; overwriting it would hand the old one (a rotated
  // master key's hash, say) to every instance for the copy's five minutes.
  await redis.set(`nexus:setting:${key}`, value ?? '__null__', 'EX', CACHE_TTL, 'NX');
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await (await coreStores()).settings.set(key, value);
  await redis.set(`nexus:setting:${key}`, value, 'EX', CACHE_TTL);
  // Written through rather than dropped, so the instance that made the change never reads its own
  // stale value back — and so the next read does not pay a round trip to learn what we just wrote.
  memo.set(key, value);
}

/**
 * Drop memoised settings ahead of their expiry.
 *
 * Backs `POST /admin/cache/flush`, which is the operator's way of saying "stop serving anything you
 * remember" — and is also how a test with no interest in the memo opts out of it.
 */
export function clearSettingMemo(key?: string): void {
  memo.forget(key);
}
