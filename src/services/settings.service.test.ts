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

const { prismaMock, redisMock, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const redisMock = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
set: vi.fn(async (k: string, v: string, ...opts: unknown[]) => {
      if (opts.includes('NX') && store.has(k)) return null;
      store.set(k, v); return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
  const prismaMock = {
    appSettings: {
      findUnique: vi.fn(async () => null as { value: string } | null),
      upsert: vi.fn(async () => ({})),
    },
  };
  return { prismaMock, redisMock, store };
});

vi.mock('../lib/redis', () => ({ redis: redisMock }));
vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import { clearSettingMemo, getSetting, readSettingFresh, setSetting } from './settings.service';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  store.clear();
  clearSettingMemo();
  prismaMock.appSettings.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.SETTING_MEMO_TTL_MS;
  delete process.env.MEMO_MAX_STALE_MS;
  clearSettingMemo();
});

describe('getSetting', () => {
  it('reads through to the database and back-fills Redis on a cold miss', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('on');
    expect(redisMock.set).toHaveBeenCalledWith('nexus:setting:GUARDRAILS_ENABLED', 'on', 'EX', 300, 'NX');
  });

  it('does not touch Redis again inside the memo window', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });

    for (let i = 0; i < 20; i++) expect(await getSetting('GUARDRAILS_ENABLED')).toBe('on');

    // The whole point: twenty requests reading the same setting, one Redis round trip. This is the
    // measurement that said 31 round trips per request and 18 of them GETs.
    expect(redisMock.get).toHaveBeenCalledTimes(1);
    expect(prismaMock.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it('memoises an unset setting too', async () => {
    // `null` is a real answer and is read exactly as often as a set one. Caching only non-null
    // values would leave every unconfigured setting paying a round trip on every request — and most
    // of a default install is unconfigured.
    expect(await getSetting('NEVER_SET')).toBeNull();
    expect(await getSetting('NEVER_SET')).toBeNull();
    expect(redisMock.get).toHaveBeenCalledTimes(1);
  });

  it('goes back to Redis once the window has passed', async () => {
    vi.useFakeTimers();
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });

    await getSetting('CACHE_ENABLED');
    expect(redisMock.get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    await getSetting('CACHE_ENABLED');
    expect(redisMock.get).toHaveBeenCalledTimes(2);
  });

  it('keeps settings apart', async () => {
    prismaMock.appSettings.findUnique.mockImplementation(async () => ({ value: 'v' }));
    await getSetting('A');
    await getSetting('B');
    expect(redisMock.get).toHaveBeenCalledTimes(2);
  });

  it('bypasses the memo entirely when the TTL is zero', async () => {
    process.env.SETTING_MEMO_TTL_MS = '0';
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    await getSetting('CACHE_ENABLED');
    await getSetting('CACHE_ENABLED');
    expect(redisMock.get).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default window when the TTL is not a usable number', async () => {
    vi.useFakeTimers();
    process.env.SETTING_MEMO_TTL_MS = 'a while';
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });

    await getSetting('CACHE_ENABLED');
    vi.advanceTimersByTime(4_999);
    await getSetting('CACHE_ENABLED');
    expect(redisMock.get).toHaveBeenCalledTimes(1);
  });
});

describe('setSetting', () => {
  it('writes through the memo, so the writer never reads its own stale value', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'off' });
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('off');

    await setSetting('GUARDRAILS_ENABLED', 'on');

    // Without the write-through this returns 'off' for another five seconds — on the very instance
    // that just made the change, which is also the one whose operator is watching the dashboard.
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('on');
  });

  it('still persists and still updates Redis', async () => {
    await setSetting('CACHE_TTL_SECONDS', '600');
    expect(prismaMock.appSettings.upsert).toHaveBeenCalledOnce();
    expect(redisMock.set).toHaveBeenCalledWith('nexus:setting:CACHE_TTL_SECONDS', '600', 'EX', 300);
  });
});

describe('clearSettingMemo', () => {
  it('sends the next read back to Redis', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    await getSetting('CACHE_ENABLED');
    clearSettingMemo();
    await getSetting('CACHE_ENABLED');
    expect(redisMock.get).toHaveBeenCalledTimes(2);
  });

  it('can drop one setting without dropping the rest', async () => {
    prismaMock.appSettings.findUnique.mockImplementation(async () => ({ value: 'v' }));
    await getSetting('A');
    await getSetting('B');
    clearSettingMemo('A');

    await getSetting('A');
    await getSetting('B');
    expect(redisMock.get).toHaveBeenCalledTimes(3); // A twice, B once
  });
});

describe('with MEMO_MAX_STALE_MS: served while it is re-read', () => {
  // Only Date is faked, so a background read can still run to completion on real timers.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => {
    process.env.MEMO_MAX_STALE_MS = '30000';
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('a change made on another instance reaches this one within the bound', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('on');
    changedElsewhere('GUARDRAILS_ENABLED', 'off');

    vi.advanceTimersByTime(5_000);
    // Expired: the held value answers at once, and the one read it starts brings the change.
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('on');
    await settle();
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('off');
    expect(redisMock.get).toHaveBeenCalledTimes(2);
  });

  it('a reader idle past the bound waits for the current value', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    await getSetting('GUARDRAILS_ENABLED');
    changedElsewhere('GUARDRAILS_ENABLED', 'off');

    vi.advanceTimersByTime(30_000);
    expect(await getSetting('GUARDRAILS_ENABLED')).toBe('off');
  });

  it('never serves the master key hash past its own window', async () => {
    // Rotating the key is how an operator shuts out a leaked one.
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'old-hash' });
    expect(await getSetting('NEXUS_API_KEY_HASH')).toBe('old-hash');
    changedElsewhere('NEXUS_API_KEY_HASH', 'new-hash');

    vi.advanceTimersByTime(5_000);
    expect(await getSetting('NEXUS_API_KEY_HASH')).toBe('new-hash');
  });

  it('a failed background read keeps the setting and is logged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'on' });
    await getSetting('CACHE_ENABLED');

    vi.advanceTimersByTime(5_000);
    redisMock.get.mockRejectedValueOnce(new Error('Connection is closed.'));
    expect(await getSetting('CACHE_ENABLED')).toBe('on');
    await settle();
    expect(await getSetting('CACHE_ENABLED')).toBe('on');
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe('readSettingFresh', () => {
  it('reads the shared copy every time, and never fills the memo', async () => {
    prismaMock.appSettings.findUnique.mockResolvedValue({ value: 'v1' });
    expect(await readSettingFresh('AI_MODEL_REGISTRY')).toBe('v1');
    changedElsewhere('AI_MODEL_REGISTRY', 'v2');
    expect(await readSettingFresh('AI_MODEL_REGISTRY')).toBe('v2');

    await getSetting('AI_MODEL_REGISTRY');
    expect(redisMock.get).toHaveBeenCalledTimes(3);
  });
});

/** What another instance's setSetting leaves behind: the shared copy, changed. */
function changedElsewhere(key: string, value: string): void {
  store.set(`nexus:setting:${key}`, value);
}

describe('the shared copy a slow read fills', () => {
  it('never replaces a newer value written while the read was at the database', async () => {
    // Instance B misses the shared copy and reads the old hash; instance A rotates the key meanwhile.
    let answer: (row: { value: string }) => void = () => undefined;
    prismaMock.appSettings.findUnique.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const slow = readSettingFresh('NEXUS_API_KEY_HASH');
    await new Promise<void>((resolve) => setImmediate(resolve));

    await setSetting('NEXUS_API_KEY_HASH', 'new-hash');
    answer({ value: 'old-hash' });
    expect(await slow).toBe('old-hash');
    expect(store.get('nexus:setting:NEXUS_API_KEY_HASH')).toBe('new-hash');
  });
});
