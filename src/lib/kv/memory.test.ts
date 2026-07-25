/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryKv } from './memory';

let kv: MemoryKv;

beforeEach(() => { kv = new MemoryKv(0); });   // 0 = no sweeper; expiry is exercised directly
afterEach(()  => { kv.stop(); vi.useRealTimers(); });

// The wire shapes below are not cosmetic. Callers read these values directly — `parseFloat` on a
// float reply, `=== 'OK'` on a write, `cursor !== '0'` on a scan — so a tidier JS-native shape here
// is a silent bug at the call site rather than a failing test.
describe('strings', () => {
  it('answers null for a key that was never set', async () => {
    expect(await kv.get('nope')).toBeNull();
  });

  it('round-trips a value and reports OK', async () => {
    expect(await kv.set('k', 'v')).toBe('OK');
    expect(await kv.get('k')).toBe('v');
  });

  it('mget preserves order and answers null per missing key', async () => {
    await kv.set('a', '1');
    await kv.set('c', '3');
    expect(await kv.mget(['a', 'b', 'c'])).toEqual(['1', null, '3']);
  });

  it('del reports how many keys were actually removed', async () => {
    await kv.set('a', '1');
    await kv.set('b', '2');
    expect(await kv.del('a', 'b', 'missing')).toBe(2);
    expect(await kv.get('a')).toBeNull();
  });

  it('del accepts several keys in one call, as breaker.onSuccess issues it', async () => {
    for (const k of ['s', 'c', 'o', 'p']) await kv.set(k, '1');
    expect(await kv.del('s', 'c', 'o', 'p')).toBe(4);
  });
});

describe('SET options', () => {
  it('NX refuses to overwrite and answers null', async () => {
    await kv.set('k', 'first');
    expect(await kv.set('k', 'second', 'NX')).toBeNull();
    expect(await kv.get('k')).toBe('first');
  });

  it('NX succeeds on a free key — the breaker probe slot depends on it', async () => {
    expect(await kv.set('probe', '1', 'NX', 'EX', 30)).toBe('OK');
    expect(await kv.set('probe', '1', 'NX', 'EX', 30)).toBeNull();
  });

  it('EX sets an expiry', async () => {
    await kv.set('k', 'v', 'EX', 60);
    expect(await kv.ttl('k')).toBeGreaterThan(55);
  });

  // A session rewrites itself to refresh lastSeenAt and passes KEEPTTL *specifically* so that
  // activity never extends its life. Without it every active session would become immortal.
  it('KEEPTTL preserves the original expiry', async () => {
    await kv.set('sess', 'v1', 'EX', 100);
    const before = await kv.ttl('sess');
    await kv.set('sess', 'v2', 'KEEPTTL');
    expect(await kv.get('sess')).toBe('v2');
    expect(await kv.ttl('sess')).toBeLessThanOrEqual(before);
    expect(await kv.ttl('sess')).toBeGreaterThan(90);
  });

  it('a plain SET clears an existing expiry, as Redis does', async () => {
    await kv.set('k', 'v', 'EX', 100);
    await kv.set('k', 'v2');
    expect(await kv.ttl('k')).toBe(-1);
  });
});

describe('counters', () => {
  it('incr starts from zero on a missing key', async () => {
    expect(await kv.incr('n')).toBe(1);
    expect(await kv.incr('n')).toBe(2);
    expect(await kv.get('n')).toBe('2');
  });

  // Redis never resets a TTL on INCR, and the rate-limit windows rely on it: a refund must not
  // restart the window it refunds into.
  it('incr preserves an existing TTL', async () => {
    await kv.set('rpm', '5', 'EX', 60);
    await kv.incr('rpm');
    expect(await kv.ttl('rpm')).toBeGreaterThan(55);
  });

  it('decrby preserves an existing TTL', async () => {
    await kv.set('tpm', '100', 'EX', 60);
    await kv.decrby('tpm', 30);
    expect(await kv.get('tpm')).toBe('70');
    expect(await kv.ttl('tpm')).toBeGreaterThan(55);
  });

  // Redis answers INCRBYFLOAT with a string, and budget.service does parseFloat(String(res)).
  it('incrbyfloat answers a STRING', async () => {
    await kv.set('spend', '0');
    const res = await kv.incrbyfloat('spend', 1.5);
    expect(typeof res).toBe('string');
    expect(parseFloat(res)).toBeCloseTo(1.5);
  });

  it('incrbyfloat accumulates without drifting into float noise', async () => {
    await kv.set('spend', '0');
    for (let i = 0; i < 3; i++) await kv.incrbyfloat('spend', 0.1);
    expect(parseFloat(await kv.get('spend') as string)).toBeCloseTo(0.3, 10);
    expect(await kv.get('spend')).not.toMatch(/0\.30000000000000004/);
  });
});

describe('expiry', () => {
  it('reports the -2 / -1 sentinels', async () => {
    expect(await kv.ttl('missing')).toBe(-2);
    await kv.set('forever', 'v');
    expect(await kv.ttl('forever')).toBe(-1);
  });

  it('expire on a missing key answers 0 and sets nothing', async () => {
    expect(await kv.expire('missing', 60)).toBe(0);
  });

  it('a key past its TTL reads as absent', async () => {
    vi.useFakeTimers();
    await kv.set('k', 'v', 'EX', 10);
    vi.advanceTimersByTime(11_000);
    expect(await kv.get('k')).toBeNull();
    expect(await kv.exists('k')).toBe(0);
    expect(await kv.ttl('k')).toBe(-2);
  });

  it('an expired key does not linger in a scan', async () => {
    vi.useFakeTimers();
    await kv.set('nexus:a', 'v', 'EX', 10);
    await kv.set('nexus:b', 'v');
    vi.advanceTimersByTime(11_000);
    const [, keys] = await kv.scan('0', 'MATCH', 'nexus:*', 'COUNT', 100);
    expect(keys).toEqual(['nexus:b']);
  });
});

describe('sets', () => {
  it('adds, counts and reports membership', async () => {
    expect(await kv.sadd('s', 'a')).toBe(1);
    expect(await kv.sadd('s', 'a')).toBe(0);       // already present
    expect(await kv.sadd('s', 'b')).toBe(1);
    expect(await kv.scard('s')).toBe(2);
    expect(await kv.sismember('s', 'a')).toBe(1);
    expect(await kv.sismember('s', 'z')).toBe(0);
    expect((await kv.smembers('s')).sort()).toEqual(['a', 'b']);
  });

  it('srem removes several members at once, as the session index prunes them', async () => {
    await kv.sadd('s', 'a');
    await kv.sadd('s', 'b');
    await kv.sadd('s', 'c');
    expect(await kv.srem('s', 'a', 'b', 'gone')).toBe(2);
    expect(await kv.smembers('s')).toEqual(['c']);
  });

  it('drops an emptied set so exists() agrees', async () => {
    await kv.sadd('s', 'only');
    await kv.srem('s', 'only');
    expect(await kv.exists('s')).toBe(0);
    expect(await kv.smembers('s')).toEqual([]);
  });

  it('answers empty rather than throwing for a set that never existed', async () => {
    expect(await kv.smembers('nope')).toEqual([]);
    expect(await kv.scard('nope')).toBe(0);
    expect(await kv.sismember('nope', 'x')).toBe(0);
  });
});

describe('scan', () => {
  it('terminates with the string cursor "0" — deleteKeys loops on that exact value', async () => {
    await kv.set('nexus:a', '1');
    const [cursor] = await kv.scan('0', 'MATCH', 'nexus:*', 'COUNT', 100);
    expect(cursor).toBe('0');
    expect(typeof cursor).toBe('string');
  });

  it('walks every matching key across pages, returning each exactly once', async () => {
    for (let i = 0; i < 25; i++) await kv.set(`nexus:k${i}`, 'v');
    await kv.set('other:x', 'v');

    const seen: string[] = [];
    let cursor = '0';
    let guard = 0;
    do {
      const [next, keys] = await kv.scan(cursor, 'MATCH', 'nexus:*', 'COUNT', 7);
      cursor = next;
      seen.push(...keys);
      if (++guard > 100) throw new Error('scan did not terminate');
    } while (cursor !== '0');

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain('other:x');
  });

  it('a page may be empty while the walk continues', async () => {
    for (let i = 0; i < 20; i++) await kv.set(`other:${i}`, 'v');
    await kv.set('nexus:last', 'v');

    let cursor = '0';
    const seen: string[] = [];
    do {
      const [next, keys] = await kv.scan(cursor, 'MATCH', 'nexus:*', 'COUNT', 5);
      cursor = next;
      seen.push(...keys);
    } while (cursor !== '0');

    expect(seen).toEqual(['nexus:last']);
  });
});

describe('multi', () => {
  // getAndDelete destructures `const [getError, value] = results[0]`.
  it('answers ioredis’s [error, result] pairs in order', async () => {
    await kv.set('k', 'v');
    const res = await kv.multi().get('k').del('k').exec();
    expect(res).toEqual([[null, 'v'], [null, 1]]);
    expect(await kv.get('k')).toBeNull();
  });

  it('applies queued writes with nothing able to run between them', async () => {
    const res = await kv.multi().set('a', '1', 'EX', 60).del('missing').exec();
    expect(res[0]).toEqual([null, 'OK']);
    expect(res[1]).toEqual([null, 0]);
  });
});

describe('scripts', () => {
  it('refuses a script with no twin, loudly and by name', async () => {
    await expect(kv.eval('return 1', 0)).rejects.toThrow(/no in-memory twin/);
  });

  // A Lua script reaching eval() without a twin means a code path that would quietly do nothing —
  // admitting every request past a rate limit, for instance. Failing is the safe behaviour.
  it('names defineScript in the error so the fix is obvious', async () => {
    await expect(kv.eval('return redis.call("GET", KEYS[1])', 1, 'k')).rejects.toThrow(/defineScript/);
  });
});

describe('connection surface', () => {
  it('answers PING', async () => {
    expect(await kv.ping()).toBe('PONG');
  });

  it('reports INFO the health parser can read, without inventing a version', async () => {
    await kv.set('k', 'v');
    const info = await kv.info();
    expect(info).toMatch(/used_memory:\d+/);
    expect(info).toMatch(/maxmemory:0/);
    // There is no server here, so claiming a version would be a fabrication.
    expect(info).not.toMatch(/redis_version/);
  });

  it('accepts on/off without a connection to emit anything', () => {
    expect(() => kv.on()).not.toThrow();
    expect(() => kv.off()).not.toThrow();
  });
});

describe('type safety', () => {
  it('refuses a string command against a set, as Redis does', async () => {
    await kv.sadd('s', 'a');
    await expect(kv.get('s')).rejects.toThrow(/WRONGTYPE/);
  });

  it('refuses a set command against a string', async () => {
    await kv.set('k', 'v');
    await expect(kv.smembers('k')).rejects.toThrow(/WRONGTYPE/);
  });
});

describe('memory hygiene', () => {
  it('the sweeper reclaims expired keys nobody reads again', async () => {
    vi.useFakeTimers();
    const swept = new MemoryKv(1000);
    try {
      await swept.set('a', 'v', 'EX', 1);
      await swept.set('b', 'v');
      expect(swept.store.size()).toBe(2);
      vi.advanceTimersByTime(2500);
      expect(swept.store.size()).toBe(1);
    } finally { swept.stop(); }
  });
});
