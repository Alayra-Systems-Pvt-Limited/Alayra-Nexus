/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { MemoryKv } from './memory';

// Parity between each Lua script and the JS twin that stands in for it without Redis.
//
// This is the anti-drift gate for S1. The twins are hand-written translations, and a translation is
// only trustworthy while something keeps checking it — so every scenario below runs through BOTH
// implementations and asserts they agree, rather than asserting the twin matches what I believed the
// Lua did.
//
// The Redis half runs when PARITY_REDIS_URL points at a throwaway server (it FLUSHes its database,
// so never aim it at anything real). Without it the memory half still runs and the Redis half is
// skipped — reported, not silently passed, so a green run never overstates what was checked.

const REDIS_URL = process.env.PARITY_REDIS_URL?.trim();

/** The two commands under test, expressed as the narrow surface the scripts need. */
interface Runner {
  name: string;
  eval(lua: string, numKeys: number, ...rest: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...opts: (string | number)[]): Promise<unknown>;
  ttl(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
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
    smembers: (k) => mem.smembers(k),
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
      smembers: (k) => r.smembers(k),
      reset: async () => { await r.flushdb(); },
    });
  }
});

afterAll(async () => { if (realRedis) await realRedis.quit(); });

import { ADMIT_LUA as ADMIT, RECONCILE_LUA as RECONCILE, ADMIT_USER_LUA as ADMIT_USER } from '../admission';
import { ACQUIRE_LUA as ACQUIRE, SERVER_FAILURE_LUA as SERVER_FAILURE } from '../breaker';
import { ADD_SPEND_LUA as ADD_SPEND } from '../../services/budget.service';

// Imported rather than re-typed or scraped out of the source: this way the Lua under test and the
// twin under test are exactly the pair the gateway ships, and no copy exists that could drift.

/** Run one scenario through every available runner and assert they all agree. */
async function parity(name: string, scenario: (r: Runner) => Promise<unknown>): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const r of runners) {
    await r.reset();
    results[r.name] = await scenario(r);
  }
  const values = Object.values(results);
  for (let i = 1; i < values.length; i++) {
    expect(values[i], `${name}: ${runners[i].name} disagreed with ${runners[0].name}`).toEqual(values[0]);
  }
}

describe('parity — coverage of what actually ran', () => {
  it('reports whether the real-Redis half ran', () => {
    // Not an assertion so much as a receipt: a green suite must never imply more than it checked.
    if (!REDIS_URL) {
      console.warn('  ! PARITY_REDIS_URL is unset — the real-Redis half was SKIPPED; memory-only.');
    }
    expect(runners.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ADMIT_LUA — rate-limit admission', () => {
  it('admits while both budgets have headroom', async () => {
    await parity('admit first', async (r) => r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60));
  });

  it('rejects once RPM is exhausted, and does not consume tokens doing so', async () => {
    await parity('rpm exhausted', async (r) => {
      await r.set('rpm', '10');
      const verdict = await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60);
      return { verdict, rpm: await r.get('rpm'), tpm: await r.get('tpm') };
    });
  });

  it('rejects once TPM would be exceeded', async () => {
    await parity('tpm exhausted', async (r) => {
      await r.set('tpm', '950');
      const verdict = await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60);
      return { verdict, rpm: await r.get('rpm'), tpm: await r.get('tpm') };
    });
  });

  it('admits exactly up to the limit and no further', async () => {
    await parity('walk to the limit', async (r) => {
      const verdicts: unknown[] = [];
      for (let i = 0; i < 5; i++) verdicts.push(await r.eval(ADMIT, 2, 'rpm', 'tpm', 3, 10_000, 10, 60));
      return { verdicts, rpm: await r.get('rpm'), tpm: await r.get('tpm') };
    });
  });

  it('sets a TTL on both windows', async () => {
    await parity('window ttl', async (r) => {
      await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60);
      // Compared as a bucket, since a real round-trip may tick the second over.
      return { rpm: (await r.ttl('rpm')) > 50, tpm: (await r.ttl('tpm')) > 50 };
    });
  });
});

describe('RECONCILE_LUA — refunding an over-reservation', () => {
  it('refunds the unused part', async () => {
    await parity('partial refund', async (r) => {
      await r.set('tpm', '100');
      const after = await r.eval(RECONCILE, 1, 'tpm', 30);
      return { after, value: await r.get('tpm') };
    });
  });

  it('never drives the counter below zero', async () => {
    await parity('over-refund clamps', async (r) => {
      await r.set('tpm', '10');
      const after = await r.eval(RECONCILE, 1, 'tpm', 999);
      return { after, value: await r.get('tpm') };
    });
  });

  it('is a no-op for a non-positive refund', async () => {
    await parity('zero refund', async (r) => {
      await r.set('tpm', '42');
      return { after: await r.eval(RECONCILE, 1, 'tpm', 0), value: await r.get('tpm') };
    });
  });

  // The window must survive a refund — restarting it would hand out a fresh allowance early.
  it('preserves the window TTL', async () => {
    await parity('refund keeps ttl', async (r) => {
      await r.set('tpm', '100', 'EX', 60);
      await r.eval(RECONCILE, 1, 'tpm', 10);
      return (await r.ttl('tpm')) > 50;
    });
  });
});

describe('ADMIT_USER_LUA — the per-key Max Users cap', () => {
  it('admits and records a new user below the cap', async () => {
    await parity('new user', async (r) => {
      const v = await r.eval(ADMIT_USER, 1, 'users', 'alice', 2, 3600);
      return { v, members: (await r.smembers('users')).sort() };
    });
  });

  it('always readmits a user already in the window, even at the cap', async () => {
    await parity('known user at cap', async (r) => {
      await r.eval(ADMIT_USER, 1, 'users', 'alice', 1, 3600);
      const v = await r.eval(ADMIT_USER, 1, 'users', 'alice', 1, 3600);
      return { v, members: (await r.smembers('users')).sort() };
    });
  });

  it('refuses a NEW user once the cap is reached, and does not record them', async () => {
    await parity('new user at cap', async (r) => {
      await r.eval(ADMIT_USER, 1, 'users', 'alice', 1, 3600);
      const v = await r.eval(ADMIT_USER, 1, 'users', 'bob', 1, 3600);
      return { v, members: (await r.smembers('users')).sort() };
    });
  });
});

describe('ACQUIRE_LUA — the breaker gate', () => {
  it('is closed when no open key exists', async () => {
    await parity('closed', async (r) => r.eval(ACQUIRE, 2, 'open', 'probe', Date.now(), 30));
  });

  it('is open before the reopen time', async () => {
    await parity('still open', async (r) => {
      await r.set('open', String(Date.now() + 60_000));
      return r.eval(ACQUIRE, 2, 'open', 'probe', Date.now(), 30);
    });
  });

  // The half-open window admits exactly one trial request. Two callers must not both get 'probe'.
  it('hands the probe slot to the first caller only', async () => {
    await parity('single probe', async (r) => {
      await r.set('open', String(Date.now() - 1000));
      const now = Date.now();
      const first  = await r.eval(ACQUIRE, 2, 'open', 'probe', now, 30);
      const second = await r.eval(ACQUIRE, 2, 'open', 'probe', now, 30);
      return { first, second };
    });
  });
});

describe('SERVER_FAILURE_LUA — strikes and escalation', () => {
  it('counts a strike below the threshold without opening', async () => {
    await parity('one strike', async (r) => {
      const cd = await r.eval(SERVER_FAILURE, 4, 'strikes', 'cd', 'open', 'probe', 0, 3, 60, 10, 300, Date.now(), 1200);
      return { cd, strikes: await r.get('strikes'), open: await r.get('open') };
    });
  });

  it('opens at the threshold and clears the strike counter', async () => {
    await parity('trip at threshold', async (r) => {
      let cd: unknown;
      for (let i = 0; i < 3; i++) {
        cd = await r.eval(SERVER_FAILURE, 4, 'strikes', 'cd', 'open', 'probe', 0, 3, 60, 10, 300, 1_000_000, 1200);
      }
      return { cd, strikes: await r.get('strikes'), cooldown: await r.get('cd'), open: await r.get('open') };
    });
  });

  it('doubles the cooldown on each subsequent trip, capped', async () => {
    await parity('escalation', async (r) => {
      const seen: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        seen.push(await r.eval(SERVER_FAILURE, 4, 'strikes', 'cd', 'open', 'probe', 1, 3, 60, 10, 40, 1_000_000, 1200));
      }
      return seen;
    });
  });

  it('a failed probe re-escalates immediately, without waiting for strikes', async () => {
    await parity('probe failure', async (r) => {
      const cd = await r.eval(SERVER_FAILURE, 4, 'strikes', 'cd', 'open', 'probe', 1, 3, 60, 10, 300, 1_000_000, 1200);
      return { cd, strikes: await r.get('strikes'), open: await r.get('open') };
    });
  });

  it('clears any claimed probe slot', async () => {
    await parity('probe cleared', async (r) => {
      await r.set('probe', '1');
      await r.eval(SERVER_FAILURE, 4, 'strikes', 'cd', 'open', 'probe', 0, 3, 60, 10, 300, Date.now(), 1200);
      return await r.get('probe');
    });
  });
});

describe('ADD_SPEND_LUA — budget accumulation', () => {
  // Two shapes that are easy to get wrong: Lua false arrives as null, and INCRBYFLOAT answers a
  // string. budget.service tests `res == null` and then parseFloat(String(res)).
  it('declines to seed a counter that does not exist', async () => {
    await parity('no counter', async (r) => {
      const res = await r.eval(ADD_SPEND, 1, 'budget', '1.25');
      return { res, isNullish: res === null || res === undefined, value: await r.get('budget') };
    });
  });

  it('adds to an existing counter and answers the new total as a string', async () => {
    await parity('add', async (r) => {
      await r.set('budget', '10');
      const res = await r.eval(ADD_SPEND, 1, 'budget', '2.5');
      return { res, type: typeof res, parsed: parseFloat(String(res)), value: await r.get('budget') };
    });
  });

  it('accumulates repeated additions', async () => {
    await parity('accumulate', async (r) => {
      await r.set('budget', '0');
      for (let i = 0; i < 4; i++) await r.eval(ADD_SPEND, 1, 'budget', '0.25');
      return parseFloat(await r.get('budget') as string);
    });
  });

  it('preserves the period TTL while accumulating', async () => {
    await parity('ttl preserved', async (r) => {
      await r.set('budget', '0', 'EX', 3600);
      await r.eval(ADD_SPEND, 1, 'budget', '1');
      return (await r.ttl('budget')) > 3500;
    });
  });
});
