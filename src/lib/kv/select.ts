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

// ── Choosing the key-value client lazily (P0.5b) ──────────────────────────────────────────────
// The gateway core keeps rate windows, breakers, sticky routes and the response cache in a
// key-value store. It used to open that store the moment `lib/redis` was imported, from REDIS_URL.
// A library must not do that: the host decides which client the core uses, and opening a socket
// at import is a side effect a host cannot undo.
//
// So `redis` is a stand-in. The real client is chosen on FIRST USE: the host's client when one was
// installed with `configure()`, otherwise the fallback (for the open-source server, REDIS_URL or the
// in-process store — exactly what it always was). Installing a client after the core has already
// used one throws, because two clients behind one name would silently split every counter.

import type Redis from 'ioredis';

export interface LazyKv {
  /** The stand-in every module imports. Each property is read from the client chosen on first use. */
  readonly kv: Redis;
  /** Install the host's client. Must run before the core first touches the store, and only once. */
  configure(client: Redis): void;
  /** The chosen client, choosing it now if nothing has yet. */
  current(): Redis;
  /** Test-only: forget the chosen client so the next use chooses again. */
  reset(): void;
}

export function createLazyKv(fallback: () => Redis): LazyKv {
  let chosen: Redis | undefined;
  // Bound methods are cached per function, so the hot path does not allocate on every command; a
  // method the client gains later (ioredis `defineCommand`) is a new function and is bound when met.
  let bound = new WeakMap<(...args: unknown[]) => unknown, unknown>();

  const current = (): Redis => {
    if (!chosen) chosen = fallback();
    return chosen;
  };

  // ── The stand-in ──
  // Methods are bound to the real client, so `this` inside ioredis (and MemoryKv) is the client
  // itself and never the stand-in. Plain properties (`status`, a defined command) read through.
  const kv = new Proxy({} as Redis, {
    get(_target, prop) {
      const client = current() as unknown as Record<PropertyKey, unknown>;
      const value = client[prop];
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      let method = bound.get(fn);
      if (!method) { method = fn.bind(client); bound.set(fn, method); }
      return method;
    },
    set(_target, prop, value) {
      (current() as unknown as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in (current() as object);
    },
  });

  return {
    kv,
    current,
    configure(client: Redis): void {
      if (chosen) {
        throw new Error(
          'The Nexus core key-value store is already in use: call configureCoreKv() once, at boot, '
          + 'before the first request or any other core call.',
        );
      }
      chosen = client;
    },
    reset(): void {
      chosen = undefined;
      bound  = new WeakMap();
    },
  };
}
