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

// Parity for CHARGE_LUA, the script that adds a request's usage beyond its TPM reservation to the
// window: the Lua and its in-memory twin must agree, as parity.test.ts requires of every other
// script. It lives here rather than there only because that file is at its line budget.
//
// The Redis half runs when PARITY_REDIS_URL points at a throwaway server (it FLUSHes its database,
// so never aim it at anything real). Without it the memory half runs alone, and says so.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { MemoryKv } from './memory';
import { CHARGE_LUA, RECONCILE_LUA } from '../admission';

const REDIS_URL = process.env.PARITY_REDIS_URL?.trim();

interface Runner {
  name: string;
  eval(lua: string, numKeys: number, ...rest: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...opts: (string | number)[]): Promise<unknown>;
  ttl(key: string): Promise<number>;
  reset(): Promise<void>;
}

const runners: Runner[] = [];
let realRedis: Redis | null = null;

beforeAll(async () => {
  const mem = new MemoryKv(0);
  runners.push({
    name: 'memory',
    eval: (lua, n, ...rest) => mem.eval(lua, n, ...rest),
    get: (k) => mem.get(k),
    set: (k, v, ...o) => mem.set(k, v, ...o),
    ttl: (k) => mem.ttl(k),
    reset: async () => { for (const k of (await mem.scan('0', 'MATCH', '*', 'COUNT', 10_000))[1]) await mem.del(k); },
  });
  if (REDIS_URL) {
    realRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await realRedis.connect();
    const r = realRedis;
    runners.push({
      name: 'redis',
      eval: (lua, n, ...rest) => r.eval(lua, n, ...rest as never[]) as Promise<unknown>,
      get: (k) => r.get(k),
      set: (k, v, ...o) => r.set(k, v, ...o as never[]),
      ttl: (k) => r.ttl(k),
      reset: async () => { await r.flushdb(); },
    });
  }
});

afterAll(async () => { if (realRedis) await realRedis.quit(); });

async function parity(name: string, scenario: (r: Runner) => Promise<unknown>): Promise<void> {
  const results: unknown[] = [];
  for (const r of runners) {
    await r.reset();
    results.push(await scenario(r));
  }
  for (let i = 1; i < results.length; i++) {
    expect(results[i], `${name}: ${runners[i].name} disagreed with ${runners[0].name}`).toEqual(results[0]);
  }
}

// Halfway through a window, pinned for both halves (see parity.test.ts for why).
const NOON = Date.UTC(2026, 7, 11, 12, 0, 30);
const W = Math.floor(NOON / 60_000);

describe('CHARGE_LUA — adding usage beyond a reservation', () => {
  it('reports whether the real-Redis half ran', () => {
    if (!REDIS_URL) console.warn('  ! PARITY_REDIS_URL is unset — the real-Redis half was SKIPPED; memory-only.');
    expect(runners.length).toBeGreaterThanOrEqual(1);
  });

  it('adds the excess to the current window', async () => {
    await parity('charge adds', async (r) => {
      await r.set(`tpm:${W}`, '100');
      const after = await r.eval(CHARGE_LUA, 1, 'tpm', 50, 60, NOON);
      return { after, value: await r.get(`tpm:${W}`) };
    });
  });

  it('keeps the deadline of a window that has one', async () => {
    await parity('charge keeps ttl', async (r) => {
      await r.set(`tpm:${W}`, '100', 'EX', 30);
      await r.eval(CHARGE_LUA, 1, 'tpm', 50, 60, NOON);
      const ttl = await r.ttl(`tpm:${W}`);
      return ttl > 0 && ttl <= 30;
    });
  });

  it('gives a counter it creates the two-window deadline', async () => {
    await parity('charge creates with ttl', async (r) => {
      const after = await r.eval(CHARGE_LUA, 1, 'tpm', 50, 60, NOON);
      const ttl = await r.ttl(`tpm:${W}`);
      return { after, value: await r.get(`tpm:${W}`), ttlInRange: ttl > 60 && ttl <= 120 };
    });
  });

  it('is a no-op for a non-positive amount', async () => {
    await parity('zero charge', async (r) => {
      await r.set(`tpm:${W}`, '42');
      return { after: await r.eval(CHARGE_LUA, 1, 'tpm', 0, 60, NOON), value: await r.get(`tpm:${W}`) };
    });
  });

  it('charges into the window that is current when it runs, as a refund does', async () => {
    await parity('charge lands in the current window', async (r) => {
      await r.set(`tpm:${W}`, '100');
      await r.eval(CHARGE_LUA, 1, 'tpm', 20, 60, NOON + 60_000);
      return { reserved: await r.get(`tpm:${W}`), current: await r.get(`tpm:${W + 1}`) };
    });
  });

  it('nets out with a refund of the same size', async () => {
    await parity('charge then refund', async (r) => {
      await r.set(`tpm:${W}`, '100');
      await r.eval(CHARGE_LUA, 1, 'tpm', 30, 60, NOON);
      await r.eval(RECONCILE_LUA, 1, 'tpm', 30, 60, NOON);
      return r.get(`tpm:${W}`);
    });
  });
});
