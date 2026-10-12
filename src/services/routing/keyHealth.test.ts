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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Auth refusals: the alert says what the key store did ──────────────────────────────────────
// Everything real except storage and the KV: the breaker, the reporter, notify() and the feed
// recorder all run, against the in-memory core stores and an in-process KV. What the memory sink
// records is exactly what a host's NotificationSink receives (the hosted gateway logs each one as a
// `core_alert` line), so these assertions are on the operator-visible output itself.

const h = vi.hoisted(() => ({ kv: undefined as unknown }));
// A fresh KV per test, behind a stable object: the breaker's auth counter and the feed's coalescing
// claims must not leak from one case into the next.
vi.mock('../../lib/redis', () => ({
  redis: new Proxy({}, {
    get: (_t, p) => {
      const kv = h.kv as Record<string | symbol, unknown>;
      const v = kv[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(kv) : v;
    },
  }),
}));

import { MemoryKv } from '../../lib/kv/memory';
import { configureCoreStores, coreStores } from '../../core/stores';
import { createMemoryCoreStores, CONFORMANCE_FIXTURE, type MemoryCoreStores } from '../../core/testing';
import type { CoreStores, NotificationRow } from '../../core/ports';
import { forgetKeyRow } from '../../lib/keyRowCache';
import { clearSettingMemo } from '../settings.service';
import * as breaker from '../../lib/breaker';
import { reportAuthFailure } from './keyHealth';

const KEY = 'key-shared-1';              // active, pool "openai-main", masked sk-…1111
// Every field a NotificationSink receives. keyBanned and keyAuthRefused must both carry all of them.
const ROW_FIELDS = ['body', 'dedupeKey', 'id', 'section', 'severity', 'title', 'type'];
let m: MemoryCoreStores;

/** The memory stores, optionally with a key store that keeps every key it is asked to ban — the
 *  shape of the hosted gateway, whose ban request only logs and leaves the decision to its guard.
 *  Both writes are spied on, so a test can prove which state really changed. */
function install(keepsKeys: boolean) {
  const markBanned  = vi.fn(keepsKeys ? async () => {} : m.stores.keys.markBanned);
  const markCooling = vi.fn(m.stores.keys.markCooling);
  const stores: CoreStores = { ...m.stores, keys: { ...m.stores.keys, markBanned, markCooling } };
  configureCoreStores(() => stores);
  return { markBanned, markCooling };
}

/** The alert is fire-and-forget, so wait for the feed to settle on what it will hold. */
async function feedAfter(refusals: number): Promise<NotificationRow[]> {
  for (let i = 0; i < refusals; i++) await reportAuthFailure(KEY);
  await vi.waitFor(() => expect(m.notifications.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 20)); // let any later, duplicate alert land too
  return m.notifications;
}

const statusOf = async (keyId: string) => (await m.stores.keys.findRoutable(keyId))?.status;

beforeEach(() => {
  h.kv = new MemoryKv(0);
  m = createMemoryCoreStores(CONFORMANCE_FIXTURE);
  forgetKeyRow();
  clearSettingMemo();
});

describe('reportAuthFailure: below the threshold', () => {
  it('one refusal asks for no ban and raises no alert', async () => {
    const { markBanned } = install(false);
    await reportAuthFailure(KEY);
    await new Promise((r) => setTimeout(r, 20));
    expect(markBanned).not.toHaveBeenCalled();
    expect(m.notifications).toEqual([]);
    expect(await statusOf(KEY)).toBe('active');
  });
});

describe('reportAuthFailure: a key store that bans (the open-source gateway)', () => {
  it('bans the key and raises keyBanned, exactly as before', async () => {
    const { markBanned } = install(false);
    const feed = await feedAfter(2);
    expect(markBanned).toHaveBeenCalledWith(KEY);
    expect(await statusOf(KEY)).toBe('banned');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: 'keyBanned', severity: 'critical', section: 'nexus', dedupeKey: 'keyBanned:openai-main:sk-…1111',
    });
    expect(feed[0].title).toContain('auto-banned');
    expect(Object.keys(feed[0]).sort()).toEqual(ROW_FIELDS);
  });
});

describe('reportAuthFailure: a key store that keeps the key (the hosted gateway)', () => {
  it('raises keyAuthRefused, a warning, with the same fields, and no alert claims a ban', async () => {
    const { markBanned } = install(true);
    const feed = await feedAfter(2);
    expect(markBanned).toHaveBeenCalledWith(KEY);  // the core still asks; the store decides
    expect(await statusOf(KEY)).toBe('active');    // and nothing was banned
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: 'keyAuthRefused', severity: 'warning', section: 'nexus', dedupeKey: 'keyAuthRefused:openai-main:sk-…1111',
      title: 'Alayra Nexus: openai-main refused a key 2 times; it was not taken out of service',
    });
    expect(feed[0].body).toContain('2 times within 5 minutes');
    expect(Object.keys(feed[0]).sort()).toEqual(ROW_FIELDS);
    for (const row of feed) {
      expect(row.type).not.toBe('keyBanned');
      expect(`${row.title} ${row.body}`).not.toMatch(/banned/i);
    }
  });

  it('really changes nothing: no cooldown, the breaker stays closed, the key still routes', async () => {
    const { markCooling } = install(true);
    await feedAfter(2);
    expect(markCooling).not.toHaveBeenCalled();
    expect(await breaker.acquire(KEY)).toBe('closed');
    expect((await m.stores.keys.listRoutable('pool-openai', null)).map((k) => k.id)).toContain(KEY);
  });

  it('keeps asking on later refusals in the window, but the feed holds one alert', async () => {
    const { markBanned } = install(true);
    const feed = await feedAfter(4);
    expect(markBanned).toHaveBeenCalledTimes(3); // refusals 2, 3 and 4 each reach the threshold
    expect(feed).toHaveLength(1);
    expect(feed[0].type).toBe('keyAuthRefused');
  });
});

describe('reportAuthFailure: a key that is gone by alert time', () => {
  it('raises nothing rather than guessing', async () => {
    install(true);
    const stores = await coreStores();
    configureCoreStores(() => ({ ...stores, keys: { ...stores.keys, findRoutable: async () => null } }));
    await reportAuthFailure(KEY);
    await reportAuthFailure(KEY);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.notifications).toEqual([]);
  });
});
