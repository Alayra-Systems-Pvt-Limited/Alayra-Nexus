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
// instance that makes a change is never stale about it — `set` and `forget` are called locally by
// the same code that writes through to Redis, and both also discard a read that was already under
// way, so a load that started before the write can never put the old value back.
//
// ── One read at a time, and (when asked) nobody waiting for it ────────────────────────────────
//
// When an entry expires, the requests that arrive together all need it. They share ONE read: a
// gateway at a few hundred requests a second used to send a burst of identical reads every window.
//
// Even one read is a wait for the request that makes it, and with a large model registry it is a
// wait plus a parse: a latency spike every few seconds. `MEMO_MAX_STALE_MS` removes it. With it set,
// an expired entry is still served while one background read replaces it, for at most that many
// milliseconds after the entry was read; past that, the request waits for the read, exactly as when
// the setting is off. That bound is the whole cost, so it is capped at 30 seconds, and it is off by
// default: 0 keeps the behaviour above, where nothing older than the entry's own window is served.
//
// A background read that fails keeps the last good value (still within that bound) and says so in
// the log. It never empties the entry, and never turns a passing outage into a failed request.

import { envInt } from './envNumber';

/** The environment variable that turns on serving an expired entry while it is re-read. */
export const MAX_STALE_ENV = 'MEMO_MAX_STALE_MS';

/** The most it may be set to. A value served without a fresh read is never older than this. */
export const MAX_STALE_CAP_MS = 30_000;

/** How often a read that keeps failing is mentioned again in the log. */
const FAILURE_LOG_EVERY_MS = 30_000;

/** How long after it was read an expired entry may still be served; 0 when that is switched off. */
export function maxStaleMs(): number {
  return envInt(MAX_STALE_ENV, 0, { max: MAX_STALE_CAP_MS });
}

export interface LoadOptions {
  /**
   * False for a value whose change must reach this process within the entry's own window, such as
   * the gateway's master key: it is then never served expired, whatever `MEMO_MAX_STALE_MS` says.
   */
  stale?: boolean;
  /** The current time; tests pass it instead of faking the clock. */
  now?: number;
}

interface Entry<T> {
  value: T;
  /** When the read that produced it STARTED, so an age is never shorter than the truth. */
  readAt: number;
}

interface Failing {
  attempts: number;
  loggedAt: number;
}

export class TtlMemo<T> {
  private readonly entries = new Map<string, Entry<T>>();
  /** The read under way per key. A read stores its result only while it is still the one listed. */
  private readonly reading = new Map<string, Promise<T>>();
  private readonly failing = new Map<string, Failing>();

  /**
   * @param defaultTtlMs how long a value is held when the environment does not override it
   * @param envVar       an operator's override; `0` disables the memo entirely
   * @param label        what the log calls the value, e.g. "the model registry"
   */
  constructor(
    private readonly defaultTtlMs: number,
    private readonly envVar?: string,
    private readonly label = 'a cached value',
  ) {}

  private ttlMs(): number {
    if (!this.envVar) return this.defaultTtlMs;
    const raw = Number(process.env[this.envVar]);
    // A typo must not mean "hold it forever" or "hold nothing" — both are worse than the default.
    return Number.isFinite(raw) && raw >= 0 ? raw : this.defaultTtlMs;
  }

  /**
   * The value for `key`: held, or read through `loader`.
   *
   * Within the window, the held value. After it, one read shared by every caller that needs it. With
   * `MEMO_MAX_STALE_MS` set, an expired value younger than that is returned at once while the read
   * runs in the background. A memo switched off (window 0) calls `loader` every time, as before.
   */
  load(key: string, loader: () => Promise<T>, options: LoadOptions = {}): Promise<T> {
    const ttl = this.ttlMs();
    if (ttl === 0) return loader();

    const now = options.now ?? Date.now();
    const held = this.entries.get(key);
    if (held !== undefined) {
      // A clock that stepped backwards gives a negative age. That entry is re-read, not trusted.
      const age = now - held.readAt;
      if (age >= 0 && age < ttl) return Promise.resolve(held.value);
      if (age >= 0 && options.stale !== false && age < Math.max(ttl, maxStaleMs())) {
        // Its failure is reported where it happens; here the held value is still good to serve.
        this.read(key, loader, now, true).catch(() => undefined);
        return Promise.resolve(held.value);
      }
    }
    return this.read(key, loader, now, false);
  }

  /** Store a value this process has just written, ahead of any read already under way. */
  set(key: string, value: T, now: number = Date.now()): void {
    if (this.ttlMs() === 0) return;
    this.reading.delete(key);
    this.entries.set(key, { value, readAt: now });
  }

  /** Drop one key, or everything, and any read under way. Called by whatever also invalidates the shared copy. */
  forget(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      this.reading.clear();
      this.failing.clear();
      return;
    }
    this.entries.delete(key);
    this.reading.delete(key);
    this.failing.delete(key);
  }

  /**
   * The one read for `key`: the one under way, or a new one. `background` is true when the read was
   * started for a caller that was served the held value instead of waiting for it.
   */
  private read(key: string, loader: () => Promise<T>, startedAt: number, background: boolean): Promise<T> {
    const underway = this.reading.get(key);
    if (underway !== undefined) return underway;

    const current = (): boolean => this.reading.get(key) === run;
    const run: Promise<T> = new Promise<T>((resolve) => resolve(loader())).then(
      (value) => {
        if (current()) {
          this.reading.delete(key);
          this.entries.set(key, { value, readAt: startedAt });
          this.recovered(key);
        }
        return value;
      },
      (err: unknown) => {
        // Nothing held is touched: a failed read must never leave less than it found.
        if (current()) {
          this.reading.delete(key);
          if (background) this.reportFailure(key, err, startedAt);
        }
        throw err;
      },
    );
    this.reading.set(key, run);
    return run;
  }

  /**
   * Log a failed background read: the held copy goes on being served, and an operator should know.
   * A read a caller waited for fails that caller exactly as it would with no memo, and the caller
   * reports it; repeating it here would only add noise. `now` is when the read started: close enough
   * for a log line, and the clock `load` was given.
   */
  private reportFailure(key: string, err: unknown, now: number): void {
    const held = this.entries.get(key);
    if (held === undefined) return;
    const state = this.failing.get(key) ?? { attempts: 0, loggedAt: -Infinity };
    state.attempts += 1;
    this.failing.set(key, state);
    if (now - state.loggedAt < FAILURE_LOG_EVERY_MS) return;
    state.loggedAt = now;

    const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;
    const limit = Math.max(this.ttlMs(), maxStaleMs());
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Could not refresh ${this.label} (${key}), attempt ${state.attempts}: ${reason}. `
      + `Still serving the copy read ${secs(now - held.readAt)} ago, for at most ${secs(limit)} after it was read.`);
  }

  private recovered(key: string): void {
    const state = this.failing.get(key);
    if (state === undefined) return;
    this.failing.delete(key);
    const label = this.label.charAt(0).toUpperCase() + this.label.slice(1);
    console.info(`${label} (${key}) refreshed again after ${state.attempts} failed attempt(s).`);
  }
}
