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

// Sliding-window length for per-key RPM/TPM counters (seconds).
export const RPM_TPM_WINDOW_SECONDS = 60;

export function rpmKey(keyId: string): string { return `nexus:rpm:${keyId}`; }
export function tpmKey(keyId: string): string { return `nexus:tpm:${keyId}`; }

// Atomic admission: check RPM and TPM budgets and, only if BOTH have headroom,
// increment the request counter by one and reserve `reserve` tokens — all in a
// single Redis round-trip so concurrent requests cannot both pass a check that
// only one of them should. Returns 1 on admit, 0 on reject. This replaces the
// previous read-then-increment sequence, which had a check-to-increment race.
const ADMIT_LUA = `
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
`;

// Refund an over-reservation once real usage is known. Clamped so the counter is
// never driven below zero, and DECRBY preserves the window's existing TTL.
const RECONCILE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local giveBack = tonumber(ARGV[1])
if giveBack > cur then giveBack = cur end
if giveBack <= 0 then return cur end
return redis.call('DECRBY', KEYS[1], giveBack)
`;

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
