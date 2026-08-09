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

import Redis from 'ioredis';
import { MemoryKv } from './kv/memory';

const REDIS_URL = process.env.REDIS_URL?.trim();

/**
 * The key-value store, chosen once at import (S1).
 *
 * With REDIS_URL set this is ioredis, byte for byte what it always was. Without it, an in-process
 * store answering the same commands — which is what makes running with no Redis a real option
 * rather than a crash. `lib/mode.ts` decides what the gateway REPORTS; this decides what it USES,
 * and both read the same variable so they cannot disagree.
 *
 * This used to throw on a missing REDIS_URL. It no longer needs to: `bootGuard.ts` already refuses,
 * before this module is reached, any configuration the gateway cannot honour — and with a message
 * that names the setting rather than the symptom.
 *
 * The exported name stays `redis`, deliberately. Eighteen modules import it and sixteen test files
 * mock it as `vi.mock('../lib/redis', () => ({ redis: { … } }))`; renaming it would touch every one
 * of them for no gain.
 */
/**
 * What a command does when Redis is not answering — measured, not assumed.
 *
 * ── What it used to do ────────────────────────────────────────────────────────────────────────
 *
 * ioredis retries a command up to `maxRetriesPerRequest` times (default 20) and then rejects it
 * with `MaxRetriesPerRequestError`. Measured against a stopped Redis, that rejection arrives after
 * about ten seconds — and it arrives as a REJECTED PROMISE, which is only ever as safe as the
 * least careful call site in the codebase. One background timer without a `.catch` turned it into
 * an unhandled rejection, and an unhandled rejection ends the process. A cost-control gateway
 * exiting because its rate-limit store is unreachable is the failure this pair of options removes.
 *
 * ── The three states, and why one option cannot cover them ────────────────────────────────────
 *
 * A command can be waiting for three different reasons, and they need different answers:
 *
 *   retries exhausted   → `maxRetriesPerRequest: null`. Never manufacture the rejection that ended
 *                         the process. Retry for as long as the outage lasts.
 *   disconnected        → the offline queue holds it. `commandTimeout` bounds the wait — measured:
 *                         a 2000ms timeout rejected a queued command at 2002ms, so the timer does
 *                         cover the queue and not merely the wire.
 *   connected but wedged→ same timeout, same bound.
 *
 * Without the timeout, `maxRetriesPerRequest: null` on its own is strictly worse than the bug it
 * fixes: measured, a command issued during an outage never settled at all. That converts a crash
 * into an unbounded hang, which fills a caller's connection pool instead of answering it.
 *
 * ── Why the offline queue stays ON ────────────────────────────────────────────────────────────
 *
 * `enableOfflineQueue: false` looks like the tidier answer — reject instantly rather than queue —
 * and it is a trap. The socket is also not open for the first few milliseconds of the process's
 * life, so with the queue off, commands issued during boot fail against a Redis that is perfectly
 * healthy. Measured: 0 of 50 succeeded, including the dependency ping the gateway boots with. That
 * trades a rare outage bug for a common startup one.
 *
 * The cost of keeping it: entries stay in the queue after their own timeout has rejected them, so
 * a long outage grows the queue and reconnection replays it. The replayed commands have already
 * been answered — their callers got a 503 — so the results are discarded, and a replayed reservation
 * expires with the RPM/TPM window it belongs to. Bounded and self-healing, and a great deal better
 * than exiting. Putting a breaker in front of the KV would remove it properly; that is a change
 * with its own risks and belongs in its own review, not smuggled in here.
 */
const KV_COMMAND_TIMEOUT_MS = parseInt(process.env.NEXUS_KV_COMMAND_TIMEOUT_MS ?? '2000', 10);

export const redis = (REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      // Two seconds rather than one, deliberately. A healthy command measured p50 0.9ms, p99 1.7ms,
      // worst 2.45ms — so even one second is six hundred times the observed ceiling, and the choice
      // is not about Redis. It is about THIS process: the gateway is CPU-bound at saturation, and
      // this timer fires on its event loop. Too tight a budget starts rejecting commands that Redis
      // answered perfectly well while the loop was busy — a false timeout, which costs a spurious
      // 503 and a reservation for a request that never happened. One extra second during a genuine
      // wedge is the cheaper mistake.
      commandTimeout: KV_COMMAND_TIMEOUT_MS,
    })
  : new MemoryKv()) as unknown as Redis;

/**
 * Every command this codebase actually issues, as a shape MemoryKv must satisfy.
 *
 * The cast above is unavoidable — ioredis's type is enormous and the memory store implements a
 * deliberate subset — but a bare cast would also silence a genuinely missing method until it threw
 * in production. This declaration is the guard: the assignment below is a compile error the moment
 * MemoryKv stops covering something the gateway calls, or a signature drifts.
 *
 * Adding a Redis command anywhere in `src` means adding it here and to MemoryKv. That is the intent.
 */
interface UsedCommands {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ...opts: (string | number)[]): Promise<'OK' | null>;
  del(...keys: (string | string[])[]): Promise<number>;
  unlink(...keys: (string | string[])[]): Promise<number>;
  exists(...keys: (string | string[])[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number | string): Promise<number>;
  ttl(key: string): Promise<number>;
  sadd(key: string, ...members: (string | string[])[]): Promise<number>;
  srem(key: string, ...members: (string | string[])[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  eval(lua: string, numKeys: number | string, ...rest: (string | number)[]): Promise<unknown>;
  multi(): { exec(): Promise<[Error | null, unknown][]> };
  ping(): Promise<string>;
  info(): Promise<string>;
}

// Never read at runtime; it exists so `tsc` proves the memory store covers the surface in use.
const _memoryCoversEveryCommandWeUse: UsedCommands = new MemoryKv();
void _memoryCoversEveryCommandWeUse;

/** True when the in-process store is in use. Read by health reporting; nothing else should care. */
export const usingMemoryKv = !REDIS_URL;

// ── Error logging ─────────────────────────────────────────────────────────────
// ioredis emits an `error` per reconnection attempt. Logging the full object each
// time buries the one line an operator needs under twenty identical stack traces.
// Log the first occurrence, then collapse repeats into a periodic count.
const ERROR_LOG_INTERVAL_MS = 30_000;
let lastLoggedAt = 0;
let suppressedCount = 0;
let silenced = 0;

/**
 * Silence the reconnection log while a caller is deliberately probing the
 * connection (see services/preflight.service.ts) and wants to print its own
 * message. Returns the function that restores logging. Re-entrant.
 */
export function suppressRedisErrorLog(): () => void {
  silenced++;
  return () => { silenced = Math.max(0, silenced - 1); };
}

redis.on('error', (err: Error & { code?: string }) => {
  if (silenced) return;
  const now = Date.now();
  if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) { suppressedCount++; return; }
  const repeats = suppressedCount ? ` (${suppressedCount} more since last message)` : '';
  lastLoggedAt = now;
  suppressedCount = 0;
  console.error(`Redis ${err.code ?? 'error'}: ${err.message}${repeats}`);
});

export async function setWithExpiry(key: string, value: string, ttlSeconds: number): Promise<void> {
  await redis.set(key, value, 'EX', ttlSeconds);
}

export async function getAndDelete(key: string): Promise<string | null> {
  // Use pipeline for atomicity
  const multi = redis.multi();
  multi.get(key);
  multi.del(key);
  
  const results = await multi.exec();
  
  if (!results || results.length === 0) return null;
  
  // Results array structure: [[error, valueForGet], [error, valueForDel]]
  const [getError, value] = results[0];
  if (getError) {
    console.error('Redis multi GET error', getError);
    return null;
  }
  
  return typeof value === 'string' ? value : null;
}

export async function increment(key: string): Promise<number> {
  return await redis.incr(key);
}

export async function setExpiry(key: string, ttlSeconds: number): Promise<void> {
  await redis.expire(key, ttlSeconds);
}
