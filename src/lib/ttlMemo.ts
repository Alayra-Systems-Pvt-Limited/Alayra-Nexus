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

// A value held in this process for a few seconds, in front of one held in Redis.
//
// ── Why there is a second tier at all ─────────────────────────────────────────────────────────
//
// Several things the gateway reads on every request already sit in Redis: the model registry, the
// active provider pools, each setting. Redis is the right place for them, because it is shared and
// a write on one instance is immediately visible to the others.
//
// It is also a network round trip. `npm run bench:store-ops` counted **31 of them per request**
// against a real Redis, which is why the same gateway measures 671 requests a second on the
// standalone file and 281 on Postgres and Redis. The cost is not CPU — a profiler shows nothing,
// because the process is not using any while it waits — it is sequential waiting.
//
// So this is a small memo in front of the shared copy, for values that change when an operator
// edits something and never between two consecutive requests.
//
// ── What the window costs, stated plainly ─────────────────────────────────────────────────────
//
// Today a change made on one instance reaches every other instance immediately, because they all
// read the shared copy. A memo is the one thing that changes that: another instance can go on
// serving the previous value until its entry expires.
//
// That is the whole price, and it is why the windows here are seconds rather than minutes. The
// saving comes from holding a value across the requests that arrive while it is hot, not from
// holding it long: at a few hundred requests a second, five seconds already removes better than
// 99.9% of the reads. Every second after that buys a rounding error and widens the window in which
// two instances disagree.
//
// The instance that makes a change is never stale about it — `set` and `forget` are called locally
// by the same code that writes through to Redis.

export class TtlMemo<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  /**
   * @param defaultTtlMs how long a value is held when the environment does not override it
   * @param envVar       an operator's override; `0` disables the memo entirely
   */
  constructor(private readonly defaultTtlMs: number, private readonly envVar?: string) {}

  private ttlMs(): number {
    if (!this.envVar) return this.defaultTtlMs;
    const raw = Number(process.env[this.envVar]);
    // A typo must not mean "hold it forever" or "hold nothing" — both are worse than the default.
    return Number.isFinite(raw) && raw >= 0 ? raw : this.defaultTtlMs;
  }

  /** The held value, or `undefined` when there is nothing usable. */
  get(key: string, nowMs: number = Date.now()): T | undefined {
    if (this.ttlMs() === 0) return undefined;
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (nowMs >= hit.expiresAt) { this.entries.delete(key); return undefined; }
    return hit.value;
  }

  set(key: string, value: T, nowMs: number = Date.now()): void {
    const ttl = this.ttlMs();
    if (ttl === 0) return;
    this.entries.set(key, { value, expiresAt: nowMs + ttl });
  }

  /** Drop one key, or everything. Called by whatever also invalidates the shared copy. */
  forget(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
