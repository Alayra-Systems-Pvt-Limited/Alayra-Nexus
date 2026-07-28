/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The flag that turns a locked-up gateway into one that says what it is doing (Phase A4).
//
// Two things here are easy to get subtly wrong and impossible to notice in production: the estimate
// arithmetic, which is only ever read by a human who will believe it, and the in-process cache,
// which sits on the proxy hot path. Both are pinned with a fake clock rather than tolerances.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { get, set, del } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('../lib/redis', () => ({ redis: { get, set, del } }));

import {
  MAINTENANCE_KEY, beginMaintenance, reportProgress, endMaintenance,
  readMaintenance, resetMaintenanceCache,
} from './maintenance.service';

const T0 = 1_700_000_000_000;

/** The JSON the KV would hold, as `load()` will parse it. */
const stored = (over: Record<string, unknown> = {}) => JSON.stringify({
  reason: 'a backup is being restored', startedAt: T0, rowsWritten: 0, rowsExpected: null, updatedAt: T0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMaintenanceCache();
  get.mockResolvedValue(null);
  set.mockResolvedValue('OK');
  del.mockResolvedValue(1);
});
afterEach(() => { vi.useRealTimers(); });

describe('raising and lowering the flag', () => {
  it('writes the flag under the key the restore wipe spares', async () => {
    await beginMaintenance('a backup is being restored', 500);
    expect(set.mock.calls[0][0]).toBe(MAINTENANCE_KEY);
  });

  it('gives it a TTL, so a killed process does not leave the gateway down forever', async () => {
    await beginMaintenance('restoring');
    // A flag only a successful restore removes is a permanent outage the first time one crashes.
    expect(set.mock.calls[0].slice(2)).toEqual(['EX', 300]);
  });

  it('deletes the flag when it is lowered', async () => {
    await endMaintenance();
    expect(del).toHaveBeenCalledWith(MAINTENANCE_KEY);
  });

  it('reports nothing once lowered, without going back to the store', async () => {
    await endMaintenance();
    get.mockClear();
    expect(await readMaintenance()).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('the estimate', () => {
  it('offers no percentage when the total is unknown', async () => {
    // The row count lives in the backup's trailer, at the END of the file, so a restore that was
    // given no hint genuinely cannot know its own denominator.
    get.mockResolvedValue(stored({ rowsWritten: 5_000, rowsExpected: null }));
    vi.setSystemTime(T0 + 10_000);

    const v = (await readMaintenance())!;
    expect(v.percent).toBeNull();
    expect(v.etaSeconds).toBeNull();
    expect(v.retryAfterSeconds).toBe(30);   // still tells the caller something
  });

  it('says "estimating" rather than a wrong number in the first moments', async () => {
    // Four rows in forty milliseconds extrapolates to nonsense. A missing estimate is waited out;
    // a wrong one is believed.
    get.mockResolvedValue(stored({ rowsWritten: 4, rowsExpected: 100_000 }));
    vi.setSystemTime(T0 + 40);

    expect((await readMaintenance())!.etaSeconds).toBeNull();
  });

  it('computes the remaining time once there is a rate worth extrapolating', async () => {
    // 2,000 rows in 4s is 2ms a row; 8,000 remain, so 16s.
    get.mockResolvedValue(stored({ rowsWritten: 2_000, rowsExpected: 10_000 }));
    vi.setSystemTime(T0 + 4_000);

    const v = (await readMaintenance())!;
    expect(v.etaSeconds).toBe(16);
    expect(v.percent).toBe(20);
    expect(v.retryAfterSeconds).toBe(16);
  });

  it('never reports more than 100 percent', async () => {
    // The hint comes from the client and is not to be trusted with a progress bar's dignity.
    get.mockResolvedValue(stored({ rowsWritten: 999, rowsExpected: 100 }));
    vi.setSystemTime(T0 + 5_000);
    expect((await readMaintenance())!.percent).toBe(100);
  });

  it('stops estimating once the written count reaches the total', async () => {
    get.mockResolvedValue(stored({ rowsWritten: 10_000, rowsExpected: 10_000 }));
    vi.setSystemTime(T0 + 4_000);
    expect((await readMaintenance())!.etaSeconds).toBeNull();
  });

  it('caps Retry-After so a caller comes back and finds the gateway up', async () => {
    // A three-minute restore that told everyone to wait two hours would have been worse than saying
    // nothing. Clients that honour Retry-After honour it exactly.
    get.mockResolvedValue(stored({ rowsWritten: 1_000, rowsExpected: 100_000_000 }));
    vi.setSystemTime(T0 + 10_000);

    const v = (await readMaintenance())!;
    expect(v.etaSeconds).toBeGreaterThan(300);
    expect(v.retryAfterSeconds).toBe(300);
  });

  it('floors Retry-After, so nobody is told to retry immediately into a locked database', async () => {
    get.mockResolvedValue(stored({ rowsWritten: 99_999, rowsExpected: 100_000 }));
    vi.setSystemTime(T0 + 3_000);
    expect((await readMaintenance())!.retryAfterSeconds).toBe(5);
  });
});

describe('the hot-path cache', () => {
  it('answers repeated checks without a round trip', async () => {
    // This runs on every proxy request, and the answer is "no" essentially always. Paying a network
    // hop per request to learn that would be a permanent tax for a rare event.
    get.mockResolvedValue(null);
    await readMaintenance();
    await readMaintenance();
    await readMaintenance();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('looks again once the cached answer is stale', async () => {
    await readMaintenance();
    vi.setSystemTime(T0 + 1_100);
    await readMaintenance();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('sees its own change immediately rather than after the cache expires', async () => {
    // The instance running the restore must not serve traffic for a second after raising the flag.
    get.mockResolvedValue(null);
    expect(await readMaintenance()).toBeNull();

    await beginMaintenance('restoring', 10);
    expect(await readMaintenance()).not.toBeNull();
  });
});

describe('progress reporting', () => {
  it('refreshes the flag, which is what keeps a live restore from expiring', async () => {
    await beginMaintenance('restoring', 1_000);
    vi.setSystemTime(T0 + 2_000);
    await reportProgress(500);

    const last = set.mock.calls[set.mock.calls.length - 1];
    expect(JSON.parse(last[1] as string).rowsWritten).toBe(500);
    expect(last.slice(2)).toEqual(['EX', 300]);
  });

  it('throttles, so a fast restore does not write to the store a hundred times a second', async () => {
    await beginMaintenance('restoring', 1_000);
    const afterBegin = set.mock.calls.length;

    await reportProgress(100);
    await reportProgress(200);
    await reportProgress(300);
    expect(set.mock.calls.length).toBe(afterBegin);   // all within the same second

    vi.setSystemTime(T0 + 1_100);
    await reportProgress(400);
    expect(set.mock.calls.length).toBe(afterBegin + 1);
  });

  it('does nothing when the flag is already gone', async () => {
    // Racing the end of a restore must not resurrect the flag and strand the gateway.
    resetMaintenanceCache();
    get.mockResolvedValue(null);
    vi.setSystemTime(T0 + 5_000);

    await reportProgress(100);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('a flag that cannot be understood', () => {
  it('is treated as absent rather than taking the gateway down', async () => {
    // Failing open is the safe direction here: the worst case is serving during a restore, which is
    // exactly what happened before this feature existed. Failing closed would be a total outage
    // caused by one unparseable string.
    get.mockResolvedValue('{not json');
    expect(await readMaintenance()).toBeNull();
  });

  it('is treated as absent when it parses but is not a state', async () => {
    get.mockResolvedValue('{"hello":"world"}');
    expect(await readMaintenance()).toBeNull();
  });
});
