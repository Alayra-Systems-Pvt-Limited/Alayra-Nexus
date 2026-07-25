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

// Sliding-window length for per-key RPM/TPM counters (seconds).
export const RPM_TPM_WINDOW_SECONDS = 60;

export function rpmKey(keyId: string): string { return `nexus:rpm:${keyId}`; }
export function tpmKey(keyId: string): string { return `nexus:tpm:${keyId}`; }
export function usersKey(keyId: string): string { return `nexus:users:${keyId}`; }

// Rolling window over which a key's distinct end-users are counted for the per-key Max Users cap.
// A day by default: "how many distinct people this key serves" is a coarse fairness cap, not a
// per-second rate limit (RPM/TPM remain the hard limits).
export const MAXUSERS_WINDOW_SECONDS = parseInt(process.env.NEXUS_MAXUSERS_WINDOW_SECONDS ?? '86400', 10);

// Atomic admission: check RPM and TPM budgets and, only if BOTH have headroom,
// increment the request counter by one and reserve `reserve` tokens — all in a
// single Redis round-trip so concurrent requests cannot both pass a check that
// only one of them should. Returns 1 on admit, 0 on reject. This replaces the
// previous read-then-increment sequence, which had a check-to-increment race.
export const ADMIT_LUA = defineScript(`
local rpm = tonumber(redis.call('GET', KEYS[1]) or '0')
local tpm = tonumber(redis.call('GET', KEYS[2]) or '0')
local rpmLimit = tonumber(ARGV[1])
local tpmLimit = tonumber(ARGV[2])
local reserve  = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])
if rpm + 1 > rpmLimit then return 0 end
if tpm + reserve > tpmLimit then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('INCRBY', KEYS[2], reserve)
redis.call('EXPIRE', KEYS[2], ttl)
return 1
`, ([rpmKeyName, tpmKeyName], [rpmLimit, tpmLimit, reserve, ttl], kv) => {
  // Line-for-line with the Lua above. Synchronous throughout, which is what makes it atomic in a
  // single-threaded process — the same property the Lua buys across processes.
  const rpm = Number(kv.get(rpmKeyName) ?? '0');
  const tpm = Number(kv.get(tpmKeyName) ?? '0');
  if (rpm + 1 > Number(rpmLimit)) return 0;
  if (tpm + Number(reserve) > Number(tpmLimit)) return 0;
  kv.incr(rpmKeyName);
  kv.expire(rpmKeyName, ttl);
  kv.incrby(tpmKeyName, Number(reserve));
  kv.expire(tpmKeyName, ttl);
  return 1;
});

// Refund an over-reservation once real usage is known. Clamped so the counter is
// never driven below zero, and DECRBY preserves the window's existing TTL.
export const RECONCILE_LUA = defineScript(`
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local giveBack = tonumber(ARGV[1])
if giveBack > cur then giveBack = cur end
if giveBack <= 0 then return cur end
return redis.call('DECRBY', KEYS[1], giveBack)
`, ([tpmKeyName], [amount], kv) => {
  const cur = Number(kv.get(tpmKeyName) ?? '0');
  let giveBack = Number(amount);
  if (giveBack > cur) giveBack = cur;
  if (giveBack <= 0) return cur;
  // DECRBY, not a set: it preserves the window's TTL, so a refund never restarts the window.
  return kv.decrby(tpmKeyName, giveBack);
});

/**
 * Atomically admit one request against a key's RPM and TPM budgets, reserving
 * `reserve` tokens. Returns true only if the key had headroom for both.
 */
export async function admitKey(keyId: string, rpmLimit: number, tpmLimit: number, reserve: number): Promise<boolean> {
  const result = await redis.eval(
    ADMIT_LUA,
    2,
    rpmKey(keyId),
    tpmKey(keyId),
    String(rpmLimit),
    String(tpmLimit),
    String(Math.max(1, Math.ceil(reserve))),
    String(RPM_TPM_WINDOW_SECONDS),
  );
  return result === 1;
}

/**
 * Reconcile a TPM reservation down to actual usage: refund `reserved - actual`
 * tokens to the key's TPM window. A no-op when the request used at least what it
 * reserved. Pass `actual = 0` to fully release a reservation for a failed request.
 */
export async function reconcileTpm(keyId: string, reserved: number, actual: number): Promise<void> {
  const giveBack = Math.floor(reserved - actual);
  if (giveBack <= 0) return;
  await redis.eval(RECONCILE_LUA, 1, tpmKey(keyId), String(giveBack));
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
