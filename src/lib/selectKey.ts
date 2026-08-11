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
import { openKey, probeKey, PROBE_TTL_SECONDS, type BreakerGate } from './breaker';
import { rpmKey, tpmKey, usersKey, RPM_TPM_WINDOW_SECONDS, MAXUSERS_WINDOW_SECONDS } from './admission';
import { RATE_WINDOW_LUA, rateWindow, rateCount, windowTtl } from './rateWindow';

// Pick the first usable key in a pool and reserve on it, in ONE round trip.
//
// ── The cost this removes ─────────────────────────────────────────────────────────────────────
//
// Routing used to ask three separate questions of the KV about EVERY candidate, one at a time:
// a breaker gate, a Max Users admission, and an atomic RPM/TPM reservation. A key that failed the
// last of them had already cost two round trips, and the router paid that for every key it rejected
// before finding one that worked. `bench:routing` measured the shape — about two extra round trips
// per exhausted pool walked, growing linearly with how deep the walk went.
//
// That is the wrong way round. The walk gets deeper exactly when keys are running out, so the system
// got slower at the moment it was already under the most pressure.
//
// Here the whole candidate list goes in one call and the loop runs inside the KV. Depth costs Redis
// CPU — a few reads per rejected key — but no additional network hops. One request, one hop, however
// many keys had to be turned down.
//
// ── Two bugs that only became visible once the sequence was written down in one place ─────────
//
// The old order performed its side effects as it went, which meant a key that was rejected LATE had
// already been written to:
//
//   The probe slot. A half-open key's probe is claimed with SET NX, and exactly one caller may hold
//   it. `breaker.acquire` claimed it BEFORE the RPM/TPM check, so a half-open key that was then
//   skipped for lack of headroom left the slot claimed for its full TTL — thirty seconds in which
//   the breaker could not send the trial request it was waiting to send. A key recovering from an
//   outage stayed dark longer precisely when its pool was busy.
//
//   The user set. `admitUser` SADDs a new end-user before RPM/TPM is checked, so a key that was
//   skipped still counted that user against its Max Users cap forever after.
//
// So this reads everything first and writes only once a key has passed every test. The probe claim
// goes first among the writes because it is the only one that can fail — losing the race to another
// caller skips the key with nothing yet written.
//
// ── Scope ─────────────────────────────────────────────────────────────────────────────────────
//
// One call per POOL, covering every key in it. The sweep across pools is still a call each, so a
// deployment shaped as one pool per provider with many keys — which is the shape the product is for
// — now pays one hop per provider rather than one per key.

/** What the caller must supply per candidate, in the order the router wants them tried. */
export interface Candidate {
  id: string;
  rpmLimit: number;
  tpmLimit: number;
  maxUsers: number;
}

export interface Selection {
  /** Index into the candidates array. */
  index: number;
  gate: BreakerGate;
}

/** Five KV keys per candidate, in this order. Kept in one place so Lua and its twin cannot disagree. */
const KEYS_PER_CANDIDATE = 5;
/** Shared ARGV before the per-candidate limits begin. */
const SHARED_ARGV = 6;
/** Three limits per candidate, after the shared ARGV. */
const ARGV_PER_CANDIDATE = 3;

// KEYS: per candidate — open, probe, users, rpm, tpm
// ARGV[1] nowMs  [2] probeTtl  [3] rpmTpmWindow  [4] reserve  [5] userId ('' = no identity)
//     [6] maxUsersWindow, then three per candidate: rpmLimit, tpmLimit, maxUsers
// Returns { 1-based index, gate } or { -1, '' } when no key could be admitted.
export const SELECT_KEY_LUA = defineScript(`${RATE_WINDOW_LUA}
local nowMs      = tonumber(ARGV[1])
local probeTtl   = tonumber(ARGV[2])
local window     = tonumber(ARGV[3])
local reserve    = tonumber(ARGV[4])
local userId     = ARGV[5]
local userWindow = tonumber(ARGV[6])
local n = #KEYS / ${KEYS_PER_CANDIDATE}

-- Redis runs Lua 5.1, which has no 'goto continue', so a per-candidate function stands in for it:
-- returning early from here is the loop's 'next'. Returns the gate on success, or nil to skip.
local function tryOne(i)
  local base   = (i - 1) * ${KEYS_PER_CANDIDATE}
  local openK  = KEYS[base + 1]
  local probeK = KEYS[base + 2]
  local usersK = KEYS[base + 3]
  local rpmK   = KEYS[base + 4]
  local tpmK   = KEYS[base + 5]

  local abase    = ${SHARED_ARGV} + (i - 1) * ${ARGV_PER_CANDIDATE}
  local rpmLimit = tonumber(ARGV[abase + 1])
  local tpmLimit = tonumber(ARGV[abase + 2])
  local maxUsers = tonumber(ARGV[abase + 3])

  -- Reads only, from here to the write block. Nothing below may leave a mark on a key it rejects.
  local gate = 'closed'
  local open = redis.call('GET', openK)
  if open then
    if nowMs < tonumber(open) then return nil end
    gate = 'probe'
  end

  local userIsNew = false
  if userId ~= '' then
    if redis.call('SISMEMBER', usersK, userId) == 0 then
      if redis.call('SCARD', usersK) >= maxUsers then return nil end
      userIsNew = true
    end
  end

  -- One rule, defined in rateWindow.ts and pasted into both admission scripts. See #135 for what
  -- a single counter with a use-refreshed expiry did instead of limiting a rate.
  local rcur, rprev, weight = nexusWindow(rpmK, nowMs, window)
  local tcur, tprev         = nexusWindow(tpmK, nowMs, window)
  if nexusCount(rcur, rprev, weight) + 1 > rpmLimit then return nil end
  if nexusCount(tcur, tprev, weight) + reserve > tpmLimit then return nil end

  -- Writes. The probe claim is first because it is the only one that can fail; losing it leaves
  -- this key untouched.
  if gate == 'probe' then
    if not redis.call('SET', probeK, '1', 'NX', 'EX', probeTtl) then return nil end
  end
  if userIsNew then
    redis.call('SADD', usersK, userId)
    redis.call('EXPIRE', usersK, userWindow)
  end
  redis.call('INCR', rcur)
  redis.call('EXPIRE', rcur, window * 2)
  redis.call('INCRBY', tcur, reserve)
  redis.call('EXPIRE', tcur, window * 2)
  return gate
end

for i = 1, n do
  local gate = tryOne(i)
  if gate then return { i, gate } end
end
return { -1, '' }
`, (keys, argv, kv) => {
  // Line-for-line with the Lua above. Synchronous throughout, which is what makes it atomic in a
  // single-threaded process — the same property the Lua buys across processes.
  const nowMs      = Number(argv[0]);
  const probeTtl   = Number(argv[1]);
  const window     = Number(argv[2]);
  const reserve    = Number(argv[3]);
  const userId     = argv[4] ?? '';
  const userWindow = Number(argv[5]);
  const n = keys.length / KEYS_PER_CANDIDATE;

  const tryOne = (i: number): BreakerGate | null => {
    const base   = (i - 1) * KEYS_PER_CANDIDATE;
    const openK  = keys[base + 0] as string;
    const probeK = keys[base + 1] as string;
    const usersK = keys[base + 2] as string;
    const rpmK   = keys[base + 3] as string;
    const tpmK   = keys[base + 4] as string;

    const abase    = SHARED_ARGV + (i - 1) * ARGV_PER_CANDIDATE;
    const rpmLimit = Number(argv[abase + 0]);
    const tpmLimit = Number(argv[abase + 1]);
    const maxUsers = Number(argv[abase + 2]);

    let gate: BreakerGate = 'closed';
    const open = kv.get(openK);
    if (open !== null) {
      if (nowMs < Number(open)) return null;
      gate = 'probe';
    }

    let userIsNew = false;
    if (userId !== '') {
      if (kv.sismember(usersK, userId) === 0) {
        if (kv.scard(usersK) >= maxUsers) return null;
        userIsNew = true;
      }
    }

    const rpmW = rateWindow(rpmK, nowMs, window);
    const tpmW = rateWindow(tpmK, nowMs, window);
    const get  = (k: string): string | null => kv.get(k);
    if (rateCount(rpmW, get) + 1 > rpmLimit) return null;
    if (rateCount(tpmW, get) + reserve > tpmLimit) return null;

    // SET NX answers 'OK' or null. Exactly one caller in the half-open window wins the probe slot,
    // and only because nothing can run between the read and the write.
    if (gate === 'probe' && !kv.set(probeK, '1', 'NX', 'EX', probeTtl)) return null;

    if (userIsNew) {
      kv.sadd(usersK, userId);
      kv.expire(usersK, userWindow);
    }
    kv.incr(rpmW.current);
    kv.expire(rpmW.current, windowTtl(window));
    kv.incrby(tpmW.current, reserve);
    kv.expire(tpmW.current, windowTtl(window));
    return gate;
  };

  for (let i = 1; i <= n; i++) {
    const gate = tryOne(i);
    if (gate) return [i, gate];
  }
  return [-1, ''];
});

/**
 * The first candidate that passes the breaker, the Max Users cap and RPM/TPM — reserved atomically.
 *
 * Returns null when every candidate was refused, which is what makes the caller's "rotate first,
 * fail last" contract hold: a request only fails once nothing in the pool has headroom.
 *
 * An empty candidate list never reaches the KV. A pool with no eligible keys is common on the sweep
 * — it is most of what walking past a pool means — and a round trip to be told about nothing is the
 * cost this whole file exists to remove.
 */
export async function selectAndReserve(
  candidates: Candidate[],
  reserveTokens: number,
  userId: string | null | undefined,
): Promise<Selection | null> {
  if (candidates.length === 0) return null;

  const keys: string[] = [];
  const limits: string[] = [];
  for (const c of candidates) {
    keys.push(openKey(c.id), probeKey(c.id), usersKey(c.id), rpmKey(c.id), tpmKey(c.id));
    limits.push(
      String(c.rpmLimit),
      String(c.tpmLimit),
      // Floor and clamp exactly as admitUser did, so a zero or fractional cap cannot admit forever.
      String(Math.max(1, Math.floor(c.maxUsers))),
    );
  }

  const result = await redis.eval(
    SELECT_KEY_LUA,
    keys.length,
    ...keys,
    String(Date.now()),
    String(PROBE_TTL_SECONDS),
    String(RPM_TPM_WINDOW_SECONDS),
    String(Math.max(1, Math.ceil(reserveTokens))),
    // A request with no user identity cannot be capped, and a missing signal must never block
    // traffic — the empty string tells the script to skip the Max Users test entirely.
    userId ?? '',
    String(MAXUSERS_WINDOW_SECONDS),
    ...limits,
  );

  if (!Array.isArray(result)) return null;
  const oneBased = Number(result[0]);
  if (!Number.isFinite(oneBased) || oneBased < 1) return null;

  const gate = String(result[1]);
  return { index: oneBased - 1, gate: gate === 'probe' ? 'probe' : 'closed' };
}
