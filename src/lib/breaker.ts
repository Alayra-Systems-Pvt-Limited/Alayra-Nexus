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

import { redis } from './redis';

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Per-key resilience state, held entirely in Redis so it is atomic and correct
// across replicas (no DB writes on the hot path, same ethos as admission.ts). The
// DB `status`/`coolingUntil` columns are kept in sync by the service layer purely
// for dashboard display — the live routing gate is acquire() below.
//
// States: closed (healthy) → open (cooling, skipped) → half-open (exactly one
// probe request is let through) → closed on probe success, or re-open (escalated)
// on probe failure.

// Consecutive server-side failures within this window before the breaker trips.
export const STRIKE_THRESHOLD      = 3;
// Sliding window over which strikes accumulate (seconds).
export const STRIKE_WINDOW_SECONDS = 300;
// First cooldown when the breaker trips, doubled on each subsequent trip.
export const BASE_COOLDOWN_SECONDS = 10;
// Hard ceiling for the escalating cooldown.
export const MAX_COOLDOWN_SECONDS  = 600;
// How long a claimed half-open probe slot is held before it can be reclaimed
// (guards against a probe request that dies without reporting a result).
export const PROBE_TTL_SECONDS     = 30;
// A key that returns this many auth errors (401/403) in-window is banned outright:
// a bad credential is not a transient failure and will not recover on its own.
export const AUTH_BAN_THRESHOLD    = 2;
export const AUTH_WINDOW_SECONDS   = 300;
// 429s get their own flat, non-escalating cooldown and never feed the strike
// counter — a rate limit is expected back-pressure, not an outage.
export const RATE_LIMIT_COOLDOWN_SECONDS = 60;

export type BreakerGate = 'closed' | 'open' | 'probe';

export function strikesKey(keyId: string):  string { return `nexus:breaker:strikes:${keyId}`; }
export function cooldownKey(keyId: string): string { return `nexus:breaker:cooldown:${keyId}`; }
export function openKey(keyId: string):     string { return `nexus:breaker:open:${keyId}`; }
export function probeKey(keyId: string):    string { return `nexus:breaker:probe:${keyId}`; }
export function authKey(keyId: string):     string { return `nexus:breaker:auth:${keyId}`; }

/**
 * Next escalating cooldown given the current one. First trip uses the base; each
 * subsequent trip doubles, capped. Pure so the escalation curve is unit-testable
 * without Redis.
 */
export function nextCooldown(currentSeconds: number, base = BASE_COOLDOWN_SECONDS, cap = MAX_COOLDOWN_SECONDS): number {
  const next = currentSeconds <= 0 ? base : currentSeconds * 2;
  return Math.min(cap, next);
}

// The `open` key is stored with a value of the absolute reopen time (ms) and a TTL
// well past that time, so it survives INTO the half-open window. acquire() compares
// now against the stored value rather than relying on key expiry — if the key were
// simply set to expire at the cooldown boundary it would vanish exactly when the
// probe logic needs it, silently dumping full traffic back onto a dead provider.
const OPEN_KEY_TTL_SECONDS = MAX_COOLDOWN_SECONDS * 4;

// KEYS[1]=open KEYS[2]=probe | ARGV[1]=nowMs ARGV[2]=probeTtl
const ACQUIRE_LUA = `
local open = redis.call('GET', KEYS[1])
if not open then return 'closed' end
if tonumber(ARGV[1]) < tonumber(open) then return 'open' end
local claimed = redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[2]))
if claimed then return 'probe' else return 'open' end
`;

// KEYS[1]=strikes KEYS[2]=cooldown KEYS[3]=open KEYS[4]=probe
// ARGV[1]=isProbe ARGV[2]=threshold ARGV[3]=strikeWindow ARGV[4]=base
// ARGV[5]=cap ARGV[6]=nowMs ARGV[7]=openTtl
// Returns the cooldown seconds if the breaker (re)opened, or 0 if it did not.
const SERVER_FAILURE_LUA = `
redis.call('DEL', KEYS[4])
local function trip()
  local cd = tonumber(redis.call('GET', KEYS[2]) or '0')
  local base = tonumber(ARGV[4])
  local cap  = tonumber(ARGV[5])
  if cd <= 0 then cd = base else cd = cd * 2 end
  if cd > cap then cd = cap end
  redis.call('SET', KEYS[2], cd, 'EX', tonumber(ARGV[7]))
  redis.call('SET', KEYS[3], tonumber(ARGV[6]) + cd * 1000, 'EX', tonumber(ARGV[7]))
  redis.call('DEL', KEYS[1])
  return cd
end
if tonumber(ARGV[1]) == 1 then return trip() end
local strikes = redis.call('INCR', KEYS[1])
if strikes == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
if strikes >= tonumber(ARGV[2]) then return trip() end
return 0
`;

/**
 * Live routing gate for a key. Atomically decides whether the key is usable now
 * and, in the half-open window, claims the single probe slot for the caller.
 * A 'probe' result means this request is the trial one — its outcome must be
 * reported back via onSuccess / onServerFailure so the breaker can close or
 * re-escalate.
 */
export async function acquire(keyId: string): Promise<BreakerGate> {
  const result = await redis.eval(
    ACQUIRE_LUA, 2,
    openKey(keyId), probeKey(keyId),
    String(Date.now()), String(PROBE_TTL_SECONDS),
  );
  return result === 'probe' ? 'probe' : result === 'open' ? 'open' : 'closed';
}

/** A healthy response fully closes the breaker and resets all escalation state. */
export async function onSuccess(keyId: string): Promise<void> {
  await redis.del(strikesKey(keyId), cooldownKey(keyId), openKey(keyId), probeKey(keyId));
}

/**
 * Record a server-side failure (5xx / timeout / hung stream). A failure during a
 * half-open probe re-escalates immediately; otherwise strikes accumulate and the
 * breaker trips at the threshold. Returns whether it opened and for how long.
 */
export async function onServerFailure(keyId: string, isProbe: boolean): Promise<{ opened: boolean; cooldownSeconds: number }> {
  const cd = await redis.eval(
    SERVER_FAILURE_LUA, 4,
    strikesKey(keyId), cooldownKey(keyId), openKey(keyId), probeKey(keyId),
    isProbe ? '1' : '0',
    String(STRIKE_THRESHOLD), String(STRIKE_WINDOW_SECONDS),
    String(BASE_COOLDOWN_SECONDS), String(MAX_COOLDOWN_SECONDS),
    String(Date.now()), String(OPEN_KEY_TTL_SECONDS),
  );
  const seconds = typeof cd === 'number' ? cd : Number(cd);
  return { opened: seconds > 0, cooldownSeconds: seconds };
}

/**
 * Record a 429. Flat, non-escalating cooldown that does not touch the strike
 * counter — rate limits are expected back-pressure, distinct from an outage.
 */
export async function onRateLimit(keyId: string, seconds = RATE_LIMIT_COOLDOWN_SECONDS): Promise<void> {
  const until = Date.now() + seconds * 1000;
  await redis
    .multi()
    .set(openKey(keyId), String(until), 'EX', OPEN_KEY_TTL_SECONDS)
    .del(probeKey(keyId))
    .exec();
}

/**
 * Record an auth failure (401/403). Returns { banned: true } once the in-window
 * count reaches the threshold, at which point the caller should ban the key.
 */
export async function onAuthFailure(keyId: string): Promise<{ banned: boolean }> {
  const n = await redis.incr(authKey(keyId));
  if (n === 1) await redis.expire(authKey(keyId), AUTH_WINDOW_SECONDS);
  await redis.del(probeKey(keyId));
  return { banned: n >= AUTH_BAN_THRESHOLD };
}
