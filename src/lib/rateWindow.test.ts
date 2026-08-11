/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── What the window is supposed to do, stated in numbers ──────────────────────────────────────
//
// `kv/parity.test.ts` drives both admission scripts and asserts the Lua and its twin AGREE. That
// catches drift between them and nothing else — a mistake made identically in both halves passes
// every parity test there is, because agreeing wrongly is still agreeing.
//
// Mutation testing said so out loud. Weighting the previous window at a flat 1, or at 0, or reading
// only the current one, or rounding the window index up instead of down, or dropping the TPM check
// entirely: every one of those survived the parity suite untouched. Only a mutation applied to one
// half was caught.
//
// So this file asserts expected values rather than equality between implementations, and it drives
// BOTH scripts — including `SELECT_KEY_LUA`, which is the one the request path actually calls, and
// which is where #135 really lived while the fix went into the other one.

import { describe, it, expect } from 'vitest';
import { MemoryKv } from './kv/memory';
import { ADMIT_LUA, RECONCILE_LUA, RPM_TPM_WINDOW_SECONDS } from './admission';
import { SELECT_KEY_LUA } from './selectKey';
import { rateWindow } from './rateWindow';

const WINDOW = RPM_TPM_WINDOW_SECONDS;              // 60 seconds
/** Halfway through a window, so a weighting mistake cannot hide behind a factor of 1 or 0. */
const NOON = Date.UTC(2026, 7, 11, 12, 0, 30);
const W = Math.floor(NOON / (WINDOW * 1000));

const kv = (): MemoryKv => new MemoryKv(0);

/** One admission through the single-key primitive. */
const admit = (k: MemoryKv, rpmLimit: number, tpmLimit: number, reserve: number, nowMs: number) =>
  k.eval(ADMIT_LUA, 2, 'rpm', 'tpm', rpmLimit, tpmLimit, reserve, WINDOW, nowMs);

/**
 * One admission through the script the gateway really runs.
 *
 * One candidate key, no breaker, no user identity — everything except the rate window held still,
 * so a failure here can only be the window.
 */
const select = (k: MemoryKv, rpmLimit: number, tpmLimit: number, reserve: number, nowMs: number) =>
  k.eval(
    SELECT_KEY_LUA, 5,
    'open', 'probe', 'users', 'rpm', 'tpm',
    nowMs, 5, WINDOW, reserve, '', 86_400,
    rpmLimit, tpmLimit, 1_000_000,
  );

/** Did `selectAndReserve` find a key? It answers [index, gate] or [-1, '']. */
const picked = (r: unknown): boolean => Array.isArray(r) && Number(r[0]) === 1;

describe('the window index', () => {
  it('is the number of whole windows since the epoch', () => {
    expect(rateWindow('rpm', NOON, WINDOW).current).toBe(`rpm:${W}`);
    expect(rateWindow('rpm', NOON, WINDOW).previous).toBe(`rpm:${W - 1}`);
  });

  it('rounds down, so an instant belongs to the window it is inside', () => {
    // Rounding up would put every instant in the window that has not started yet, and the counter
    // a request landed in would never be the one the next request read.
    const start = W * WINDOW * 1000;
    expect(rateWindow('rpm', start, WINDOW).current).toBe(`rpm:${W}`);
    expect(rateWindow('rpm', start + 59_999, WINDOW).current).toBe(`rpm:${W}`);
    expect(rateWindow('rpm', start + 60_000, WINDOW).current).toBe(`rpm:${W + 1}`);
  });

  it('names a plain integer, with no exponent', () => {
    // Belt and braces rather than a bug being prevented: Lua stringifies numbers with `%.14g`, and
    // a window index is nowhere near large enough to come out as 2.9e+07. It is formatted anyway,
    // because a key name that changes shape with the magnitude of a clock is not worth relying on.
    expect(rateWindow('rpm', NOON, WINDOW).current).toMatch(/^rpm:\d+$/);
  });

  it('weighs the previous window by how much of it is still in range', () => {
    const start = W * WINDOW * 1000;
    expect(rateWindow('rpm', start, WINDOW).weight).toBeCloseTo(1, 5);
    expect(rateWindow('rpm', start + 15_000, WINDOW).weight).toBeCloseTo(0.75, 5);
    expect(rateWindow('rpm', start + 30_000, WINDOW).weight).toBeCloseTo(0.5, 5);
    expect(rateWindow('rpm', start + 45_000, WINDOW).weight).toBeCloseTo(0.25, 5);
  });
});

// Both scripts, the same expectations. `run` is whichever one is under test, and every case below
// asserts a number rather than an agreement.
describe.each([
  ['ADMIT_LUA (the single-key primitive)', async (k: MemoryKv, l: number, n: number) => (await admit(k, l, 1e9, 1, n)) === 1],
  ['SELECT_KEY_LUA (what the request path calls)', async (k: MemoryKv, l: number, n: number) => picked(await select(k, l, 1e9, 1, n))],
])('%s', (_label, run) => {
  it('admits exactly up to the limit inside one window', async () => {
    const k = kv();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 12; i++) verdicts.push(await run(k, 10, NOON));
    expect(verdicts.filter(Boolean)).toHaveLength(10);
  });

  it('counts a full previous window at half weight, halfway through this one', async () => {
    // 10 carried at 0.5 is 5, so a limit of 10 has exactly 5 left. Not 10 (previous ignored), and
    // not 0 (previous counted in full) — the two mutations that pass every parity test.
    const k = kv();
    await k.set(`rpm:${W - 1}`, '10');
    const verdicts: boolean[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(await run(k, 10, NOON));
    expect(verdicts.filter(Boolean)).toHaveLength(5);
  });

  it('counts a full previous window in full at the very start of this one', async () => {
    const k = kv();
    await k.set(`rpm:${W - 1}`, '10');
    expect(await run(k, 10, W * WINDOW * 1000)).toBe(false);
  });

  it('has forgotten a window that has fully passed', async () => {
    // Two windows back is outside the trailing minute at every instant. A limiter that remembers
    // longer than its own window is the bug this replaced.
    const k = kv();
    await k.set(`rpm:${W - 2}`, '1000');
    expect(await run(k, 10, NOON)).toBe(true);
  });

  it('serves a steady trickle indefinitely, instead of using it up', async () => {
    // #135, stated as a test. One request every 10 seconds against 10/min is a sixth of the rating.
    // The old counter climbed to 10 and then refused for a minute; walked across four whole windows,
    // every one of these must be admitted.
    const k = kv();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 24; i++) verdicts.push(await run(k, 10, NOON + i * 10_000));
    expect(verdicts.filter(Boolean)).toHaveLength(24);
  });

  it('does not hand out a second full allowance at a window boundary', async () => {
    // Why this is a sliding window and not a fixed one. Spend the limit at the end of a window and
    // ask again just after it: a fixed window would have reset and served the lot again, which is
    // twice the rating inside two seconds.
    const k = kv();
    const before: boolean[] = [];
    for (let i = 0; i < 10; i++) before.push(await run(k, 10, (W + 1) * WINDOW * 1000 - 500));
    expect(before.filter(Boolean)).toHaveLength(10);
    expect(await run(k, 10, (W + 1) * WINDOW * 1000 + 500)).toBe(false);
  });

  it('writes its count into the window it read', async () => {
    // The mutation that survived everything else: writing to the un-suffixed key. The limit then
    // reads a counter nothing ever increments and admits without bound.
    const k = kv();
    await run(k, 10, NOON);
    expect(await k.get(`rpm:${W}`)).toBe('1');
    expect(await k.get('rpm')).toBeNull();
  });

  it('gives a window long enough to be read from the next one', async () => {
    const k = kv();
    await run(k, 10, NOON);
    expect(await k.ttl(`rpm:${W}`)).toBeGreaterThan(WINDOW);
  });
});

describe('tokens, which are counted the same way and refused separately', () => {
  it('refuses on TPM while RPM still has room', async () => {
    // Dropping the TPM check entirely survives every parity test, because both halves drop it.
    const k = kv();
    expect(await admit(k, 1000, 100, 60, NOON)).toBe(1);
    expect(await admit(k, 1000, 100, 60, NOON)).toBe(0);
    expect(await k.get(`rpm:${W}`)).toBe('1');
  });

  it('refuses on TPM in the live path too', async () => {
    const k = kv();
    expect(picked(await select(k, 1000, 100, 60, NOON))).toBe(true);
    expect(picked(await select(k, 1000, 100, 60, NOON))).toBe(false);
  });

  it('carries reserved tokens into the next window at the same weight', async () => {
    const k = kv();
    await k.set(`tpm:${W - 1}`, '100');
    expect(await admit(k, 1e9, 100, 60, NOON)).toBe(0);   // 100 * 0.5 + 60 > 100
    expect(await admit(k, 1e9, 100, 40, NOON)).toBe(1);   // 100 * 0.5 + 40 <= 100
  });

  it('refunds an over-reservation into the window it is in', async () => {
    const k = kv();
    await admit(k, 1e9, 1e9, 100, NOON);
    expect(await k.get(`tpm:${W}`)).toBe('100');
    await k.eval(RECONCILE_LUA, 1, 'tpm', 70, WINDOW, NOON);
    expect(await k.get(`tpm:${W}`)).toBe('30');
  });

  it('never refunds a window below zero', async () => {
    const k = kv();
    await k.set(`tpm:${W}`, '10');
    await k.eval(RECONCILE_LUA, 1, 'tpm', 999, WINDOW, NOON);
    expect(await k.get(`tpm:${W}`)).toBe('0');
  });
});
