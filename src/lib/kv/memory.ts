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

// An in-process stand-in for the subset of Redis this gateway uses (S1).
//
// Scope is deliberate: exactly the commands reached by `src/lib/redis.ts`'s importers, and no more.
// This is not a Redis clone — it is the shape the gateway needs, so running without Redis is a real
// option rather than a broken one.
//
// ── Why this can be correct without Lua ───────────────────────────────────────────────────────────
// The Lua scripts exist to make a sequence of commands atomic against OTHER PROCESSES. Node runs one
// thread and one event loop, so a synchronous function cannot be interrupted part-way: a synchronous
// JS twin of a Lua script has exactly the atomicity the Lua bought.
//
// That is why this file is built in two layers. `Store` holds every operation and is entirely
// SYNCHRONOUS; script twins are handed the Store, so they *cannot* await — the guarantee is
// structural rather than a rule someone has to remember. `MemoryKv` wraps Store in the promise-
// returning surface ioredis presents, because callers rely on it (`sso.service` does
// `redis.set(…).catch(…)`, which needs a real promise, not a value that merely awaits).
//
// The trade this cannot make is horizontal scale: two processes each keep their own counters, so
// every limit is enforced per-process. That is the documented cost of standalone mode, not a defect.
//
// ── Return types ──────────────────────────────────────────────────────────────────────────────────
// Callers read these values directly, so ioredis's wire shapes are reproduced faithfully:
// `INCRBYFLOAT` answers a string, `SET … NX` answers `'OK'` or `null`, `SCAN` answers a string
// cursor, `TTL` answers the -2/-1 sentinels. A tidier JS-native shape here is a silent bug at the
// call site.

import { globMatch } from './glob';

type Value = string | Set<string>;

interface Entry {
  value: Value;
  /** Absolute expiry in epoch ms, or null when the key never expires. */
  expiresAt: number | null;
}

const NO_SUCH_KEY = -2;
const NO_EXPIRY   = -1;

/**
 * Every operation, synchronously. This is what script twins receive.
 *
 * Nothing here returns a promise, by design: a twin that cannot await cannot interleave, which is
 * the whole atomicity argument.
 */
export class Store {
  private readonly data = new Map<string, Entry>();

  // ── Internals ───────────────────────────────────────────────────────────────

  /** The live entry for a key, dropping it first if its TTL has passed. */
  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private asString(key: string): string | null {
    const e = this.live(key);
    if (!e) return null;
    if (e.value instanceof Set) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.value;
  }

  private asSet(key: string): Set<string> | null {
    const e = this.live(key);
    if (!e) return null;
    if (!(e.value instanceof Set)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.value;
  }

  /** Drop every key whose TTL has passed. Lazy expiry alone would leak keys never read again. */
  sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.data) {
      if (e.expiresAt !== null && e.expiresAt <= now) this.data.delete(k);
    }
  }

  /** Live key count. Diagnostics and tests only. */
  size(): number {
    this.sweep();
    return this.data.size;
  }

  // ── Strings ─────────────────────────────────────────────────────────────────

  get(key: string): string | null {
    return this.asString(key);
  }

  mget(keys: string[]): (string | null)[] {
    return keys.map((k) => this.asString(k));
  }

  /**
   * SET with the option forms this codebase uses: `EX <seconds>`, `PX`, `NX`, `XX`, `KEEPTTL`.
   *
   * KEEPTTL matters more than its size suggests. A session rewrites itself to refresh `lastSeenAt`
   * and passes KEEPTTL *specifically* so activity never extends its life. Dropping the TTL on that
   * write would make every active session immortal.
   */
  set(key: string, value: string, ...opts: (string | number)[]): 'OK' | null {
    let ttlMs: number | null = null;
    let nx = false;
    let keepTtl = false;

    for (let i = 0; i < opts.length; i++) {
      const opt = String(opts[i]).toUpperCase();
      if (opt === 'EX')      { ttlMs = Number(opts[++i]) * 1000; continue; }
      if (opt === 'PX')      { ttlMs = Number(opts[++i]); continue; }
      if (opt === 'NX')      { nx = true; continue; }
      if (opt === 'XX')      { if (!this.live(key)) return null; continue; }
      if (opt === 'KEEPTTL') { keepTtl = true; continue; }
    }

    const existing = this.live(key);
    if (nx && existing) return null;

    const expiresAt = ttlMs !== null ? Date.now() + ttlMs
      : keepTtl ? (existing?.expiresAt ?? null)
      : null;   // a plain SET clears any existing TTL, as Redis does

    this.data.set(key, { value, expiresAt });
    return 'OK';
  }

  del(...keys: (string | string[])[]): number {
    let n = 0;
    for (const k of keys.flat()) {
      if (this.live(k)) n++;      // count only keys that were actually live
      this.data.delete(k);        // …but clear expired tombstones too
    }
    return n;
  }

  exists(...keys: (string | string[])[]): number {
    return keys.flat().reduce((n, k) => n + (this.live(k) ? 1 : 0), 0);
  }

  /**
   * INCR / INCRBY / DECRBY preserve an existing TTL, exactly as Redis does. The rate-limit windows
   * depend on it: RECONCILE refunds tokens with DECRBY and must not restart the window it refunds
   * into.
   */
  incrby(key: string, by: number | string): number {
    const cur = this.asString(key);
    const next = (cur === null ? 0 : Number(cur)) + Number(by);
    if (!Number.isFinite(next)) throw new Error('ERR value is not an integer or out of range');
    const existing = this.data.get(key);
    this.data.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  incr(key: string): number { return this.incrby(key, 1); }
  decrby(key: string, by: number | string): number { return this.incrby(key, -Number(by)); }

  /** Answers a STRING, as Redis does — callers parseFloat() it. */
  incrbyfloat(key: string, by: number | string): string {
    const cur = this.asString(key);
    const next = (cur === null ? 0 : parseFloat(cur)) + Number(by);
    if (!Number.isFinite(next)) throw new Error('ERR value is not a valid float');
    const existing = this.data.get(key);
    // Redis trims the float reply; matching that keeps repeated round-trips stable.
    const out = String(parseFloat(next.toPrecision(15)));
    this.data.set(key, { value: out, expiresAt: existing?.expiresAt ?? null });
    return out;
  }

  // ── Expiry ──────────────────────────────────────────────────────────────────

  expire(key: string, seconds: number | string): number {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + Number(seconds) * 1000;
    return 1;
  }

  /** -2 when the key is gone, -1 when it has no expiry, else whole seconds remaining. */
  ttl(key: string): number {
    const e = this.live(key);
    if (!e) return NO_SUCH_KEY;
    if (e.expiresAt === null) return NO_EXPIRY;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  // ── Sets ────────────────────────────────────────────────────────────────────

  sadd(key: string, ...members: (string | string[])[]): number {
    const list = members.flat().map(String);
    let s = this.asSet(key);
    if (!s) { s = new Set(); this.data.set(key, { value: s, expiresAt: null }); }
    let added = 0;
    for (const m of list) if (!s.has(m)) { s.add(m); added++; }
    return added;
  }

  srem(key: string, ...members: (string | string[])[]): number {
    const s = this.asSet(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members.flat().map(String)) if (s.delete(m)) removed++;
    // Redis drops an emptied set, and `exists` must agree.
    if (s.size === 0) this.data.delete(key);
    return removed;
  }

  smembers(key: string): string[] { return [...(this.asSet(key) ?? [])]; }
  sismember(key: string, member: string): number { return this.asSet(key)?.has(String(member)) ? 1 : 0; }
  scard(key: string): number { return this.asSet(key)?.size ?? 0; }

  // ── Scan ────────────────────────────────────────────────────────────────────

  /**
   * SCAN over the key list, paged by index.
   *
   * The cursor is an index rather than Redis's rehashing cursor, but it keeps the guarantee callers
   * depend on: every key present for the whole walk is returned exactly once. Keys added mid-walk
   * may be missed — which is what Redis promises too.
   *
   * The cursor is a STRING and '0' terminates: `deleteKeys` loops on `cursor !== '0'`, and a numeric
   * cursor would never end that loop.
   */
  scan(cursor: string | number, ...args: (string | number)[]): [string, string[]] {
    let match = '*';
    let count = 10;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'MATCH') match = String(args[++i]);
      else if (a === 'COUNT') count = Number(args[++i]);
    }

    const start = Number(cursor) || 0;
    if (start === 0) this.sweep();

    const keys = [...this.data.keys()];
    const page: string[] = [];
    let i = start;
    for (; i < keys.length && page.length < count; i++) {
      const k = keys[i];
      if (this.live(k) && globMatch(match, k)) page.push(k);
    }

    return [i >= keys.length ? '0' : String(i), page];
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  /** A rough byte count for the Health page. Honest about being an estimate. */
  approximateBytes(): number {
    let bytes = 0;
    for (const [k, e] of this.data) {
      bytes += k.length * 2;
      bytes += e.value instanceof Set
        ? [...e.value].reduce((n, m) => n + m.length * 2, 0)
        : e.value.length * 2;
    }
    return bytes;
  }
}

// ── Script registry ───────────────────────────────────────────────────────────

/** A Lua script's synchronous JS twin. Receives the Store, so it structurally cannot await. */
export type ScriptImpl = (keys: string[], argv: string[], store: Store) => unknown;

const SCRIPTS = new Map<string, ScriptImpl>();

/**
 * Declare a Lua script together with the JS twin that must behave identically, returning the Lua
 * source so the call site is unchanged:
 *
 *     const ADMIT_LUA = defineScript(`…lua…`, (keys, argv, kv) => { … });
 *
 * Keeping both halves in one expression is the point: they are read together, reviewed together, and
 * the parity suite runs the same scenario through both.
 */
export function defineScript(lua: string, impl: ScriptImpl): string {
  SCRIPTS.set(lua, impl);
  return lua;
}

/** Test seam: has this script been given a twin? */
export function hasScript(lua: string): boolean { return SCRIPTS.has(lua); }

// ── The ioredis-shaped facade ─────────────────────────────────────────────────

/**
 * The promise-returning surface the gateway's 18 importers already use. Every method delegates
 * straight to Store; the only thing this layer adds is the promise, which callers need — several do
 * `.catch(…)` on a write.
 */
export class MemoryKv {
  readonly store = new Store();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(sweepIntervalMs = 60_000) {
    if (sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => this.store.sweep(), sweepIntervalMs);
      if (typeof this.sweeper.unref === 'function') this.sweeper.unref();  // never hold the process open
    }
  }

  async get(key: string) { return this.store.get(key); }

  async mget(keys: string[] | string, ...rest: string[]) {
    return this.store.mget(Array.isArray(keys) ? keys : [keys, ...rest]);
  }

  async set(key: string, value: string, ...opts: (string | number)[]) { return this.store.set(key, value, ...opts); }
  async del(...keys: (string | string[])[])    { return this.store.del(...keys); }
  /** UNLINK differs from DEL only in freeing memory off-thread, which is meaningless in-process. */
  async unlink(...keys: (string | string[])[]) { return this.store.del(...keys); }
  async exists(...keys: (string | string[])[]) { return this.store.exists(...keys); }

  async incr(key: string)                       { return this.store.incr(key); }
  async incrby(key: string, by: number | string) { return this.store.incrby(key, by); }
  async decrby(key: string, by: number | string) { return this.store.decrby(key, by); }
  async incrbyfloat(key: string, by: number | string) { return this.store.incrbyfloat(key, by); }

  async expire(key: string, seconds: number | string) { return this.store.expire(key, seconds); }
  async ttl(key: string)                              { return this.store.ttl(key); }

  async sadd(key: string, ...m: (string | string[])[]) { return this.store.sadd(key, ...m); }
  async srem(key: string, ...m: (string | string[])[]) { return this.store.srem(key, ...m); }
  async smembers(key: string)                          { return this.store.smembers(key); }
  async sismember(key: string, member: string)         { return this.store.sismember(key, member); }
  async scard(key: string)                             { return this.store.scard(key); }

  async scan(cursor: string | number, ...args: (string | number)[]) { return this.store.scan(cursor, ...args); }

  /**
   * Run a script's registered JS twin.
   *
   * An unregistered script is a hard error, never a silent no-op: a Lua script reaching here without
   * a twin means a code path that would quietly do nothing in standalone mode — admitting every
   * request past a rate limit, say — which is far worse than crashing during development.
   */
  async eval(lua: string, numKeys: number | string, ...rest: (string | number)[]): Promise<unknown> {
    const n = Number(numKeys);
    const keys = rest.slice(0, n).map(String);
    const argv = rest.slice(n).map(String);

    const impl = SCRIPTS.get(lua);
    // `typeof` rather than a truthiness check, and it is not only defensive style. The registry is
    // module-private and only `defineScript` ever writes to it, so in this codebase `impl` is always
    // one of our own function literals — but this is the one place a value fetched by a lookup gets
    // CALLED, and a lookup that ever returned something else should stop here rather than be invoked.
    // It also states the invariant for a static analyser, which cannot see that the registry is
    // closed.
    if (typeof impl !== 'function') {
      throw new Error(
        'This Lua script has no in-memory twin. Declare it with defineScript(lua, impl) so it also ' +
        `works without Redis. Script begins: ${lua.trim().slice(0, 80)}…`,
      );
    }
    return impl(keys, argv, this.store);
  }

  /** MULTI/EXEC in ioredis's `[[err, result], …]` shape. */
  multi(): MemoryMulti { return new MemoryMulti(this.store); }

  async ping() { return 'PONG'; }

  /**
   * A minimal INFO carrying only the fields `parseRedisInfo` reads. Anything that would be a lie is
   * omitted rather than invented — there is no server here to have a version or connected clients,
   * so the Health page shows "—" instead of a fabricated number.
   */
  async info(): Promise<string> {
    return [
      '# Memory',
      `used_memory:${this.store.approximateBytes()}`,
      'maxmemory:0',
      '',
    ].join('\r\n');
  }

  /** ioredis emits connection events; there is no connection here, so nothing ever fires. */
  on(): this { return this; }
  off(): this { return this; }

  async quit() { this.stop(); return 'OK'; }
  disconnect(): void { this.stop(); }

  /** Release the sweeper. Tests call this; the gateway never needs to. */
  stop(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
  }
}

/** The queued half of MULTI/EXEC. Only the commands this codebase queues are implemented. */
export class MemoryMulti {
  private readonly queue: (() => unknown)[] = [];

  constructor(private readonly store: Store) {}

  set(key: string, value: string, ...opts: (string | number)[]): this {
    this.queue.push(() => this.store.set(key, value, ...opts));
    return this;
  }

  get(key: string): this { this.queue.push(() => this.store.get(key)); return this; }
  del(...keys: string[]): this { this.queue.push(() => this.store.del(...keys)); return this; }

  /** One `[error, result]` pair per queued command, in order — the shape `getAndDelete` unpacks. */
  async exec(): Promise<[Error | null, unknown][]> {
    return this.queue.map((run): [Error | null, unknown] => {
      try { return [null, run()]; }
      catch (err) { return [err as Error, null]; }
    });
  }
}
