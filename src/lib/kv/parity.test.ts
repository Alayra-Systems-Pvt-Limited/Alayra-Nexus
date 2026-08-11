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
import { SELECT_KEY_LUA as SELECT_KEY } from '../selectKey';

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

// Every admission scenario pins the instant, and that is not a convenience.
//
// The window index is derived from a clock — Redis's own inside the Lua, the process's inside the
// twin — and those are two different clocks that will not agree to the millisecond. Left to
// themselves the two halves can land in different windows, and the suite then fails or passes
// depending on when it was run. Pinning both to the same instant is what makes "these two agree" a
// statement about the logic rather than about the second the test started in.
//
// 12:00:30.000 UTC. Chosen halfway through a window, so the previous one is weighted 0.5 and a
// mistake in the weighting cannot hide behind a factor of 1 or 0.
const NOON = Date.UTC(2026, 7, 11, 12, 0, 30);
/** The window index NOON falls in, and the one before it. */
const W = Math.floor(NOON / 60_000);

describe('ADMIT_LUA — rate-limit admission', () => {
  it('admits while both budgets have headroom', async () => {
    await parity('admit first', async (r) => r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60, NOON));
  });

  it('rejects once RPM is exhausted, and does not consume tokens doing so', async () => {
    await parity('rpm exhausted', async (r) => {
      await r.set(`rpm:${W}`, '10');
      const verdict = await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60, NOON);
      return { verdict, rpm: await r.get(`rpm:${W}`), tpm: await r.get(`tpm:${W}`) };
    });
  });

  it('rejects once TPM would be exceeded', async () => {
    await parity('tpm exhausted', async (r) => {
      await r.set(`tpm:${W}`, '950');
      const verdict = await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60, NOON);
      return { verdict, rpm: await r.get(`rpm:${W}`), tpm: await r.get(`tpm:${W}`) };
    });
  });

  it('admits exactly up to the limit and no further', async () => {
    await parity('walk to the limit', async (r) => {
      const verdicts: unknown[] = [];
      for (let i = 0; i < 5; i++) verdicts.push(await r.eval(ADMIT, 2, 'rpm', 'tpm', 3, 10_000, 10, 60, NOON));
      return { verdicts, rpm: await r.get(`rpm:${W}`), tpm: await r.get(`tpm:${W}`) };
    });
  });

  it('sets a TTL on both windows, long enough to be read from the next one', async () => {
    await parity('window ttl', async (r) => {
      await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1000, 100, 60, NOON);
      // Compared as a bucket, since a real round-trip may tick the second over. Above 60 rather
      // than above 50: this window has to outlive itself to be weighed as the previous one.
      return { rpm: (await r.ttl(`rpm:${W}`)) > 60, tpm: (await r.ttl(`tpm:${W}`)) > 60 };
    });
  });

  // ── The window itself, which is the whole of #135 ───────────────────────────────────────────

  it('counts the previous window in proportion to how much of it is still in range', async () => {
    // Halfway through a window, a previous window holding 10 counts as 5. So a limit of 10 has
    // exactly 5 left, and the sixth request is the one that is refused.
    await parity('half-weighted carry', async (r) => {
      await r.set(`rpm:${W - 1}`, '10');
      const verdicts: unknown[] = [];
      for (let i = 0; i < 6; i++) verdicts.push(await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1e9, 1, 60, NOON));
      return { verdicts, rpm: await r.get(`rpm:${W}`) };
    });
  });

  it('forgets a window that has fully passed', async () => {
    // Two windows back is outside the trailing minute at any point, so it must count for nothing.
    // A rate limiter that remembers longer than its window is the bug this replaced.
    await parity('two windows back', async (r) => {
      await r.set(`rpm:${W - 2}`, '1000');
      return r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1e9, 1, 60, NOON);
    });
  });

  it('does not let a window boundary hand out a second full allowance', async () => {
    // The reason this is a sliding window and not a fixed one. Spend the whole limit at the end of
    // a window, cross into the next, and ask again: a fixed window would have reset and served the
    // lot a second time, which is twice the rating in two seconds.
    const endOfWindow = (W + 1) * 60_000 - 500;   // half a second before the boundary
    const justAfter   = (W + 1) * 60_000 + 500;   // half a second after it

    await parity('no boundary burst', async (r) => {
      const before: unknown[] = [];
      for (let i = 0; i < 10; i++) before.push(await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1e9, 1, 60, endOfWindow));
      const after = await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1e9, 1, 60, justAfter);
      return { admittedBefore: before.filter((v) => v === 1).length, immediatelyAfter: after };
    });
  });

  it('serves a steady trickle indefinitely, instead of using it up', async () => {
    // #135 in one scenario. One request every 10 seconds against a limit of 10/min is a sixth of
    // the rating; the old counter climbed to 10 and then refused for a minute. Walked across four
    // whole windows, every one of these must be admitted.
    await parity('steady trickle', async (r) => {
      const verdicts: unknown[] = [];
      for (let i = 0; i < 24; i++) {
        verdicts.push(await r.eval(ADMIT, 2, 'rpm', 'tpm', 10, 1e9, 1, 60, NOON + i * 10_000));
      }
      return { admitted: verdicts.filter((v) => v === 1).length, of: verdicts.length };
    });
  });
});

describe('RECONCILE_LUA — refunding an over-reservation', () => {
  it('refunds the unused part', async () => {
    await parity('partial refund', async (r) => {
      await r.set(`tpm:${W}`, '100');
      const after = await r.eval(RECONCILE, 1, 'tpm', 30, 60, NOON);
      return { after, value: await r.get(`tpm:${W}`) };
    });
  });

  it('never drives the counter below zero', async () => {
    await parity('over-refund clamps', async (r) => {
      await r.set(`tpm:${W}`, '10');
      const after = await r.eval(RECONCILE, 1, 'tpm', 999, 60, NOON);
      return { after, value: await r.get(`tpm:${W}`) };
    });
  });

  it('is a no-op for a non-positive refund', async () => {
    await parity('zero refund', async (r) => {
      await r.set(`tpm:${W}`, '42');
      return { after: await r.eval(RECONCILE, 1, 'tpm', 0, 60, NOON), value: await r.get(`tpm:${W}`) };
    });
  });

  // The window must survive a refund — restarting it would hand out a fresh allowance early.
  it('preserves the window TTL', async () => {
    await parity('refund keeps ttl', async (r) => {
      await r.set(`tpm:${W}`, '100', 'EX', 60);
      await r.eval(RECONCILE, 1, 'tpm', 10, 60, NOON);
      return (await r.ttl(`tpm:${W}`)) > 50;
    });
  });

  it('refunds into the window that is current when it runs', async () => {
    // Named because it is a real limitation rather than an accident: a request that spans a
    // boundary gives its refund to the next window, since nothing carries the window index from
    // admission through to the answer. Bounded by one request's over-reservation.
    await parity('refund lands in the current window', async (r) => {
      await r.set(`tpm:${W}`, '100');
      await r.set(`tpm:${W + 1}`, '50');
      await r.eval(RECONCILE, 1, 'tpm', 20, 60, NOON + 60_000);
      return { reserved: await r.get(`tpm:${W}`), current: await r.get(`tpm:${W + 1}`) };
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

describe('SELECT_KEY_LUA — pick a key and reserve on it, in one call', () => {
  // Five KV keys per candidate — open, probe, users, rpm, tpm — then the shared ARGV, then three
  // limits per candidate. Built here the same way selectAndReserve builds it, so the parity suite
  // exercises the real argument shape rather than a convenient one.
  const call = (
    r: Runner,
    n: number,
    opts: { reserve?: number; userId?: string; limits?: [number, number, number][]; nowMs?: number } = {},
  ): Promise<unknown> => {
    const keys: (string | number)[] = [];
    for (let i = 1; i <= n; i++) keys.push(`open${i}`, `probe${i}`, `users${i}`, `rpm${i}`, `tpm${i}`);
    const limits: (string | number)[] = [];
    for (let i = 1; i <= n; i++) {
      const [rpm, tpm, max] = opts.limits?.[i - 1] ?? [10, 100_000, 1_000];
      limits.push(rpm, tpm, max);
    }
    return r.eval(
      SELECT_KEY, keys.length, ...keys,
      opts.nowMs ?? 1_000_000, 30, 60, opts.reserve ?? 100, opts.userId ?? '', 86_400,
      ...limits,
    );
  };

  it('picks the first candidate when it has headroom', async () => {
    await parity('first wins', async (r) => ({
      chosen: await call(r, 3),
      rpm1: await r.get('rpm1'), tpm1: await r.get('tpm1'),
      rpm2: await r.get('rpm2'), tpm2: await r.get('tpm2'),
    }));
  });

  it('walks to the second when the first is out of RPM, and leaves the first untouched', async () => {
    await parity('walk on rpm', async (r) => {
      await r.set('rpm1', '10');
      return {
        chosen: await call(r, 3),
        rpm1: await r.get('rpm1'), tpm1: await r.get('tpm1'),
        rpm2: await r.get('rpm2'), tpm2: await r.get('tpm2'),
      };
    });
  });

  it('walks past a key whose TPM would be exceeded by this request alone', async () => {
    await parity('walk on tpm', async (r) => {
      await r.set('tpm1', '99_950'.replace('_', ''));
      return { chosen: await call(r, 2, { reserve: 100 }), tpm1: await r.get('tpm1'), tpm2: await r.get('tpm2') };
    });
  });

  it('returns -1 when every candidate is exhausted, having reserved on none of them', async () => {
    // "Rotate first, fail last": the caller may only fail once nothing in the pool has headroom.
    await parity('all exhausted', async (r) => {
      await r.set('rpm1', '10');
      await r.set('rpm2', '10');
      return { chosen: await call(r, 2), rpm1: await r.get('rpm1'), rpm2: await r.get('rpm2') };
    });
  });

  it('skips a breaker-open key whose cooldown has not elapsed', async () => {
    await parity('breaker open', async (r) => {
      await r.set('open1', String(2_000_000));       // reopens after now
      return { chosen: await call(r, 2, { nowMs: 1_000_000 }), rpm1: await r.get('rpm1'), rpm2: await r.get('rpm2') };
    });
  });

  it('claims the probe slot for a half-open key and reports gate=probe', async () => {
    await parity('half open', async (r) => {
      await r.set('open1', String(500_000));         // reopen time already passed
      return {
        chosen: await call(r, 1, { nowMs: 1_000_000 }),
        probe1: await r.get('probe1'), rpm1: await r.get('rpm1'),
      };
    });
  });

  it('walks past a half-open key whose probe another caller already holds', async () => {
    await parity('probe taken', async (r) => {
      await r.set('open1', String(500_000));
      await r.set('probe1', '1');                    // someone else is already probing
      return { chosen: await call(r, 2, { nowMs: 1_000_000 }), rpm1: await r.get('rpm1'), rpm2: await r.get('rpm2') };
    });
  });

  it('does NOT claim a probe slot on a half-open key it then rejects for RPM', async () => {
    // The bug the old ordering had. breaker.acquire claimed the slot before RPM was checked, so a
    // busy half-open key held the slot for its full TTL and the breaker could not send the trial
    // request it was waiting to send. A key recovering from an outage stayed dark longer exactly
    // when its pool was busy.
    await parity('probe not wasted', async (r) => {
      await r.set('open1', String(500_000));
      await r.set('rpm1', '10');
      return { chosen: await call(r, 2, { nowMs: 1_000_000 }), probe1: await r.get('probe1') };
    });
  });

  it('admits a new user and records them against the key that served', async () => {
    await parity('new user', async (r) => ({
      chosen: await call(r, 1, { userId: 'u1' }),
      users1: await r.smembers('users1'),
    }));
  });

  it('walks past a key that is full for a NEW user but would admit a known one', async () => {
    await parity('max users', async (r) => {
      await r.eval(ADMIT_USER, 1, 'users1', 'someone', 1, 86_400);   // fills the cap of 1
      return {
        newUser:   await call(r, 2, { userId: 'u-new',   limits: [[10, 100_000, 1], [10, 100_000, 1]] }),
        knownUser: await call(r, 2, { userId: 'someone', limits: [[10, 100_000, 1], [10, 100_000, 1]] }),
      };
    });
  });

  it('does NOT record a user against a key it then rejects for RPM', async () => {
    // The second bug in the old ordering: admitUser SADDed before RPM was checked, so a key that
    // was skipped still counted that user against its Max Users cap forever after.
    await parity('user not recorded on a skipped key', async (r) => {
      await r.set('rpm1', '10');
      return {
        chosen: await call(r, 2, { userId: 'u1' }),
        users1: await r.smembers('users1'),
        users2: await r.smembers('users2'),
      };
    });
  });

  it('skips the Max Users test entirely when the request carries no user identity', async () => {
    // A missing signal must never block traffic — the cap cannot be enforced without an identity.
    await parity('no identity', async (r) => ({
      chosen: await call(r, 1, { userId: '', limits: [[10, 100_000, 1]] }),
      users1: await r.smembers('users1'),
    }));
  });

  it('sets the window TTL on the counters it touches', async () => {
    await parity('ttls', async (r) => {
      await call(r, 1, { userId: 'u1' });
      return { rpm: await r.ttl('rpm1'), tpm: await r.ttl('tpm1'), users: await r.ttl('users1') };
    });
  });

  it('admits exactly up to the limit across repeated calls and then rotates', async () => {
    await parity('walk to the limit', async (r) => {
      const chosen: unknown[] = [];
      for (let i = 0; i < 5; i++) chosen.push(await call(r, 2, { limits: [[2, 100_000, 1_000], [2, 100_000, 1_000]] }));
      return { chosen, rpm1: await r.get('rpm1'), rpm2: await r.get('rpm2') };
    });
  });
});
