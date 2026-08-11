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
import { defineScript } from './kv/memory';
import { RATE_WINDOW_LUA, rateWindow, rateCount, windowTtl } from './rateWindow';

// Sliding-window length for per-key RPM/TPM counters (seconds).
export const RPM_TPM_WINDOW_SECONDS = 60;

/**
 * Prefixes, not keys.
 *
 * A window index is appended inside the script — `nexus:rpm:<keyId>:29281234` — because the index
 * is derived from Redis's own clock rather than the caller's, and the caller therefore cannot name
 * the key it is about to touch. See `ADMIT_LUA` for why that clock matters.
 *
 * The consequence worth knowing: a script that builds key names cannot run on Redis Cluster, which
 * needs every key declared up front so it can check they hash to one slot. Nexus talks to a single
 * Redis today and has no cluster support; if that changes, these become one hash per limit with the
 * window index as the field, which is declarable. Tracked with the rest of high availability.
 */
export function rpmKey(keyId: string): string { return `nexus:rpm:${keyId}`; }
export function tpmKey(keyId: string): string { return `nexus:tpm:${keyId}`; }
export function usersKey(keyId: string): string { return `nexus:users:${keyId}`; }

// Rolling window over which a key's distinct end-users are counted for the per-key Max Users cap.
// A day by default: "how many distinct people this key serves" is a coarse fairness cap, not a
// per-second rate limit (RPM/TPM remain the hard limits).
export const MAXUSERS_WINDOW_SECONDS = parseInt(process.env.NEXUS_MAXUSERS_WINDOW_SECONDS ?? '86400', 10);

// ── Admission: is there room for this request, right now, across every gateway? ───────────────
//
// Check RPM and TPM and, only if BOTH have headroom, count the request and reserve its tokens — in
// one round trip, so two requests cannot both pass a check only one of them should. That part was
// always right, and `npm run bench:multi-instance` proves it holds across separate gateways.
//
// NOT THE REQUEST PATH. Routing calls `selectAndReserve`, which walks a list of candidate keys and
// admits against whichever has room; this is the single-key primitive, kept because it states the
// rule in isolation and the parity suite can drive it directly. The two used to spell the rule out
// separately, which is how the fix for #135 went into this one, changed nothing any caller could
// see, and was caught only by the rig. The rule now lives in `rateWindow.ts` and both paste it in.
//
// ── What a "minute" used to mean ──────────────────────────────────────────────────────────────
//
// This counted into one key and called EXPIRE on it after every admitted request. Refreshing an
// expiry on use means the window never expires while it is being used: the count climbs to the
// limit however slowly traffic arrives, and the only thing that clears it is sixty consecutive
// seconds in which nothing is admitted. Since a refusal returns before the increment, that means
// sixty seconds of pure refusal. Serve N, black out for a minute, serve N.
//
// Measured before the fix: a key rated 20/min, offered 15/min, served 20 requests in 81 seconds and
// then refused for 53. It delivered about 9 a minute while never being offered more than 15.
export const ADMIT_LUA = defineScript(`${RATE_WINDOW_LUA}
local rpmLimit = tonumber(ARGV[1])
local tpmLimit = tonumber(ARGV[2])
local reserve  = tonumber(ARGV[3])
local window   = tonumber(ARGV[4])
local nowMs    = tonumber(ARGV[5])

local rcur, rprev, weight = nexusWindow(KEYS[1], nowMs, window)
local tcur, tprev         = nexusWindow(KEYS[2], nowMs, window)

if nexusCount(rcur, rprev, weight) + 1 > rpmLimit then return 0 end
if nexusCount(tcur, tprev, weight) + reserve > tpmLimit then return 0 end

redis.call('INCR', rcur)
redis.call('EXPIRE', rcur, window * 2)
redis.call('INCRBY', tcur, reserve)
redis.call('EXPIRE', tcur, window * 2)
return 1
`, ([rpmKeyName, tpmKeyName], [rpmLimit, tpmLimit, reserve, window, nowMs], kv) => {
  // Line-for-line with the Lua above. Synchronous throughout, which is what makes it atomic in a
  // single-threaded process — the same property the Lua buys across processes.
  const w    = Number(window);
  const now  = Number(nowMs);
  const rpmW = rateWindow(rpmKeyName, now, w);
  const tpmW = rateWindow(tpmKeyName, now, w);
  const get  = (k: string): string | null => kv.get(k);

  if (rateCount(rpmW, get) + 1 > Number(rpmLimit)) return 0;
  if (rateCount(tpmW, get) + Number(reserve) > Number(tpmLimit)) return 0;

  kv.incr(rpmW.current);
  kv.expire(rpmW.current, windowTtl(w));
  kv.incrby(tpmW.current, Number(reserve));
  kv.expire(tpmW.current, windowTtl(w));
  return 1;
});

// Refund an over-reservation once real usage is known. Clamped so a window is never driven below
// zero, and DECRBY rather than a set, so the refund cannot restart the window's expiry.
//
// It refunds into the window that is current WHEN THE ANSWER COMES BACK, which is not always the
// window the reservation was made in — a request that spans a boundary gives its refund to the next
// minute. The error is bounded by one request's over-reservation, it only occurs for requests
// straddling a boundary, and correcting it would mean carrying the window index from admission
// through the whole request. Named here rather than left for someone to find in the numbers.
export const RECONCILE_LUA = defineScript(`${RATE_WINDOW_LUA}
local giveBack = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local nowMs    = tonumber(ARGV[3])
local cur      = nexusWindow(KEYS[1], nowMs, window)

local held = tonumber(redis.call('GET', cur) or '0')
if giveBack > held then giveBack = held end
if giveBack <= 0 then return held end
return redis.call('DECRBY', cur, giveBack)
`, ([tpmKeyName], [amount, window, nowMs], kv) => {
  const cur = rateWindow(tpmKeyName, Number(nowMs), Number(window)).current;
  const held = Number(kv.get(cur) ?? '0');
  let giveBack = Number(amount);
  if (giveBack > held) giveBack = held;
  if (giveBack <= 0) return held;
  // DECRBY, not a set: it preserves the window's expiry, so a refund cannot restart the window.
  return kv.decrby(cur, giveBack);
});

/**
 * Atomically admit one request against a key's RPM and TPM budgets, reserving
 * `reserve` tokens. Returns true only if the key had headroom for both.
 */
export async function admitKey(
  keyId: string, rpmLimit: number, tpmLimit: number, reserve: number,
  /** Test seam: pin the instant both halves of the script see. Never passed in production. */
  nowMs?: number,
): Promise<boolean> {
  const result = await redis.eval(
    ADMIT_LUA,
    2,
    rpmKey(keyId),
    tpmKey(keyId),
    String(rpmLimit),
    String(tpmLimit),
    String(Math.max(1, Math.ceil(reserve))),
    String(RPM_TPM_WINDOW_SECONDS),
    String(nowMs ?? Date.now()),
  );
  return result === 1;
}

/**
 * Reconcile a TPM reservation down to actual usage: refund `reserved - actual`
 * tokens to the key's TPM window. A no-op when the request used at least what it
 * reserved. Pass `actual = 0` to fully release a reservation for a failed request.
 */
export async function reconcileTpm(
  keyId: string, reserved: number, actual: number,
  /** Test seam: pin the instant both halves of the script see. Never passed in production. */
  nowMs?: number,
): Promise<void> {
  const giveBack = Math.floor(reserved - actual);
  if (giveBack <= 0) return;
  await redis.eval(
    RECONCILE_LUA, 1, tpmKey(keyId),
    String(giveBack),
    String(RPM_TPM_WINDOW_SECONDS),
    String(nowMs ?? Date.now()),
  );
}

// Per-key Max Users admission, atomic in one round-trip: a user already in the key's window set is
// always admitted; a *new* user is admitted (and recorded) only while the set is below the cap;
// otherwise the key is full for new users and the caller rotates to the next key. EXPIRE renews the
// rolling window on every admitted new user.
export const ADMIT_USER_LUA = defineScript(`
local exists = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if exists == 1 then return 1 end
local card = redis.call('SCARD', KEYS[1])
if card >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`, ([usersKeyName], [userId, maxUsers, windowSeconds], kv) => {
  if (kv.sismember(usersKeyName, userId) === 1) return 1;
  if (kv.scard(usersKeyName) >= Number(maxUsers)) return 0;
  kv.sadd(usersKeyName, userId);
  kv.expire(usersKeyName, windowSeconds);
  return 1;
});

/**
 * Admit one end-user against a key's Max Users cap. When the request carries no user identity the
 * cap cannot be enforced, so this admits unconditionally — a missing signal never blocks traffic.
 * A known user always passes; a new user passes only while the key is below `maxUsers`.
 */
export async function admitUser(
  keyId: string,
  maxUsers: number,
  userId: string | null | undefined,
  windowSeconds = MAXUSERS_WINDOW_SECONDS,
): Promise<boolean> {
  if (!userId) return true;
  const result = await redis.eval(
    ADMIT_USER_LUA,
    1,
    usersKey(keyId),
    userId,
    String(Math.max(1, Math.floor(maxUsers))),
    String(windowSeconds),
  );
  return result === 1;
}
