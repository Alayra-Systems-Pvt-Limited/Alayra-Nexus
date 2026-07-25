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
export const redis = (REDIS_URL ? new Redis(REDIS_URL) : new MemoryKv()) as unknown as Redis;

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
