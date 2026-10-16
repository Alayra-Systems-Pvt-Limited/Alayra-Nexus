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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STALE_ENV, TtlMemo } from './ttlMemo';
import { resetEnvWarnings } from './envNumber';

/**
 * A loader whose reads the test settles by hand. `calls` counts the reads STARTED, which is the
 * number that matters: a stampede is many reads started for one value.
 */
function manualLoader<T>() {
  const pending: { resolve: (value: T) => void; reject: (err: unknown) => void }[] = [];
  const loader = vi.fn(() => new Promise<T>((resolve, reject) => { pending.push({ resolve, reject }); }));
  return {
    loader,
    get calls() { return loader.mock.calls.length; },
    resolve(value: T) { for (const p of pending.splice(0)) p.resolve(value); },
    reject(err: unknown) { for (const p of pending.splice(0)) p.reject(err); },
  };
}

/** Lets every settled promise run its callbacks. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** True when `promise` has resolved by the time pending callbacks have run, without awaiting it forever. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await settle();
  return done;
}

const TTL = 5_000;
let memo: TtlMemo<string>;

beforeEach(() => {
  memo = new TtlMemo<string>(TTL, 'TEST_MEMO_TTL_MS', 'the test value');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.TEST_MEMO_TTL_MS;
  delete process.env[MAX_STALE_ENV];
  resetEnvWarnings();
  vi.restoreAllMocks();
});

/** Hold `value` as read at time 0. */
async function prime(value: string): Promise<void> {
  expect(await memo.load('k', async () => value, { now: 0 })).toBe(value);
}

describe('inside the window', () => {
  it('reads once and serves every later call from memory', async () => {
    const loader = vi.fn(async () => 'v1');
    for (let t = 0; t < TTL; t += 1_000) expect(await memo.load('k', loader, { now: t })).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps keys apart', async () => {
    await memo.load('a', async () => 'A', { now: 0 });
    expect(await memo.load('b', async () => 'B', { now: 0 })).toBe('B');
  });

  it('reads every time and holds nothing when the window is 0', async () => {
    process.env.TEST_MEMO_TTL_MS = '0';
    const loader = vi.fn(async () => 'v');
    await memo.load('k', loader, { now: 0 });
    await memo.load('k', loader, { now: 0 });
    memo.set('k', 'written', 0);
    await memo.load('k', loader, { now: 0 });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('re-reads an entry from the future rather than trusting it (a clock stepped back)', async () => {
    await memo.load('k', async () => 'v1', { now: 10_000 });
    const loader = vi.fn(async () => 'v2');
    expect(await memo.load('k', loader, { now: 0 })).toBe('v2');
  });
});

describe('one read at a time', () => {
  it('callers arriving together on an empty memo share one read', async () => {
    const read = manualLoader<string>();
    const callers = Array.from({ length: 50 }, () => memo.load('k', read.loader, { now: 0 }));
    expect(read.calls).toBe(1);
    read.resolve('v1');
    expect(await Promise.all(callers)).toEqual(Array(50).fill('v1'));
  });

  it('callers that find the entry expired share one read, and all get the new value', async () => {
    await prime('v1');
    const read = manualLoader<string>();
    const callers = Array.from({ length: 50 }, () => memo.load('k', read.loader, { now: TTL }));
    expect(read.calls).toBe(1);
    read.resolve('v2');
    expect(await Promise.all(callers)).toEqual(Array(50).fill('v2'));
  });

  it('a failed shared read reaches every caller waiting on it, and the next call reads again', async () => {
    const read = manualLoader<string>();
    const callers = Array.from({ length: 5 }, () => memo.load('k', read.loader, { now: 0 }));
    read.reject(new Error('Connection is closed.'));
    for (const c of callers) await expect(c).rejects.toThrow('Connection is closed.');

    expect(await memo.load('k', async () => 'v1', { now: 0 })).toBe('v1');
  });
});

describe('expired entries, by default', () => {
  it('are never served: the caller waits for the new value, as before', async () => {
    await prime('v1');
    const read = manualLoader<string>();
    const pending = memo.load('k', read.loader, { now: TTL });
    expect(await isSettled(pending)).toBe(false);
    read.resolve('v2');
    expect(await pending).toBe('v2');
  });

  it('treat an unusable MEMO_MAX_STALE_MS as off', async () => {
    process.env[MAX_STALE_ENV] = '30s';
    await prime('v1');
    expect(await memo.load('k', async () => 'v2', { now: TTL })).toBe('v2');
  });
});

describe('expired entries with MEMO_MAX_STALE_MS', () => {
  beforeEach(() => { process.env[MAX_STALE_ENV] = '30000'; });

  it('are served at once while ONE background read replaces them', async () => {
    await prime('v1');
    const read = manualLoader<string>();
    for (let i = 0; i < 20; i++) expect(await memo.load('k', read.loader, { now: 6_000 })).toBe('v1');
    expect(read.calls).toBe(1);

    read.resolve('v2');
    await settle();
    expect(await memo.load('k', read.loader, { now: 6_001 })).toBe('v2');
    expect(read.calls).toBe(1);
  });

  it('are never served once as old as the bound: the caller waits', async () => {
    await prime('v1');
    expect(await memo.load('k', manualLoader<string>().loader, { now: 29_999 })).toBe('v1');

    memo.forget();
    await prime('v1');
    const read = manualLoader<string>();
    const pending = memo.load('k', read.loader, { now: 30_000 });
    expect(await isSettled(pending)).toBe(false);
    read.resolve('v2');
    expect(await pending).toBe('v2');
  });

  it('cap the bound at 30 seconds whatever the environment says', async () => {
    process.env[MAX_STALE_ENV] = '600000';
    await prime('v1');
    const read = manualLoader<string>();
    const pending = memo.load('k', read.loader, { now: 30_000 });
    expect(await isSettled(pending)).toBe(false);
    read.resolve('v2');
    expect(await pending).toBe('v2');
  });

  it('are not served for a value that must not be stale', async () => {
    await prime('v1');
    expect(await memo.load('k', async () => 'v2', { now: TTL, stale: false })).toBe('v2');
  });

  it('survive a failed background read, which is logged once and retried on the next call', async () => {
    await prime('v1');
    const failing = vi.fn(async () => { throw new Error('Connection is closed.'); });

    expect(await memo.load('k', failing, { now: 6_000 })).toBe('v1');
    await settle();
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = String(vi.mocked(console.warn).mock.calls[0][0]);
    expect(logged).toContain('the test value');
    expect(logged).toContain('Connection is closed.');
    expect(logged).toContain('Still serving the copy read 6s ago');

    // Not emptied: the next caller inside the bound still gets the last good value, and does not
    // wait for the read it starts.
    const read = manualLoader<string>();
    const next = memo.load('k', read.loader, { now: 29_999 });
    expect(await isSettled(next)).toBe(true);
    expect(await next).toBe('v1');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(read.calls).toBe(1);

    read.resolve('v2');
    await settle();
    expect(await memo.load('k', read.loader, { now: 29_999 })).toBe('v2');
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it('repeat a failure in the log at most every 30 seconds', async () => {
    await prime('v1');
    const failing = vi.fn(async () => { throw new Error('down'); });
    for (let t = 6_000; t < 12_000; t += 1_000) {
      await memo.load('k', failing, { now: t });
      await settle();
    }
    expect(failing).toHaveBeenCalledTimes(6);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('give the caller the error once past the bound, as with no memo', async () => {
    await prime('v1');
    await expect(memo.load('k', async () => { throw new Error('down'); }, { now: 30_000 })).rejects.toThrow('down');
  });
});

describe('local writes win over a read already under way', () => {
  it('set(): the write is kept and the older read is discarded', async () => {
    const read = manualLoader<string>();
    const early = memo.load('k', read.loader, { now: 0 });
    memo.set('k', 'mine', 0);
    read.resolve('old');
    expect(await early).toBe('old'); // it asked before the write
    const loader = vi.fn(async () => 'other');
    expect(await memo.load('k', loader, { now: 1 })).toBe('mine');
    expect(loader).not.toHaveBeenCalled();
  });

  it('forget(): the read under way is discarded and the next call reads again', async () => {
    process.env[MAX_STALE_ENV] = '30000';
    await prime('v1');
    const read = manualLoader<string>();
    await memo.load('k', read.loader, { now: 6_000 }); // background read started
    memo.forget('k');
    read.resolve('old');
    await settle();

    const loader = vi.fn(async () => 'new');
    expect(await memo.load('k', loader, { now: 6_001 })).toBe('new');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('forget() with no key drops every key', async () => {
    await memo.load('a', async () => 'A', { now: 0 });
    await memo.load('b', async () => 'B', { now: 0 });
    memo.forget();
    const loader = vi.fn(async () => 'x');
    await memo.load('a', loader, { now: 1 });
    await memo.load('b', loader, { now: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('the loader is told when its read has been overtaken', () => {
  it('current() stays true for a read nothing overtook, and turns false after set() or forget()', async () => {
    const seen: (() => boolean)[] = [];
    const read = () => (current: () => boolean) => { seen.push(current); return new Promise<string>(() => undefined); };

    void memo.load('a', read(), { now: 0 });
    void memo.load('b', read(), { now: 0 });
    void memo.load('c', read(), { now: 0 });
    memo.set('b', 'written', 0);
    memo.forget('c');
    expect(seen.map((current) => current())).toEqual([true, false, false]);
  });
});
