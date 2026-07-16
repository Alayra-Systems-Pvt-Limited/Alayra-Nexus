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

// In-memory settings store so setNotificationConfig → read round-trips.
const store = new Map<string, string>();
vi.mock('./settings.service', () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
}));

// Redis SET NX: first claim per key returns 'OK', repeats return null (coalesced). `del`
// releases a claim, so a failed delivery that releases the window can be observed as a retry.
const claimed = new Set<string>();
const redisSet = vi.fn(async (key: string, _v: string, _ex: string, _ttl: number, _nx: string) => {
  if (claimed.has(key)) return null;
  claimed.add(key);
  return 'OK';
});
const redisDel = vi.fn(async (key: string) => { claimed.delete(key); return 1; });
vi.mock('../lib/redis', () => ({ redis: {
  set: (...a: unknown[]) => redisSet(...(a as Parameters<typeof redisSet>)),
  del: (...a: unknown[]) => redisDel(...(a as Parameters<typeof redisDel>)),
} }));

// Reversible fake crypto so the round-trip is observable without a real master key.
vi.mock('../lib/encryption', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1'),
  maskKey: (s: string) => '●●●●' + s.slice(-4),
}));

// The in-app feed is its own module with its own tests; here it is stubbed so these tests stay about
// config and delivery. Recording is asserted, not exercised — what matters at this seam is that an
// alert reaches the feed even when nothing is delivered.
const recordNotification = vi.fn(async () => true);
vi.mock('./notificationFeed.service', () => ({
  recordNotification: (...a: unknown[]) => recordNotification(...(a as [])),
}));

import {
  notify, setNotificationConfig, getNotificationConfigForUI,
} from './notifications.service';
import { keyBannedMessage } from '../lib/notify';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store.clear(); claimed.clear();
  redisSet.mockClear(); redisDel.mockClear(); recordNotification.mockClear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function enable(over: Record<string, unknown> = {}) {
  await setNotificationConfig({
    enabled: true, resendApiKey: 're_live_key', from: 'alerts@x.com', to: ['ops@x.com'],
    webhookUrl: 'https://hooks.example.com/x', windowSeconds: 3600, ...over,
  });
}

describe('config storage', () => {
  it('encrypts a new key and never returns the plaintext to the UI', async () => {
    await enable();
    expect(store.get('NOTIFICATIONS_CONFIG')).toContain('enc(re_live_key)'); // ciphertext at rest
    const ui = await getNotificationConfigForUI();
    expect(ui.resendKeySet).toBe(true);
    expect(ui.resendKeyMasked).toBe('●●●●_key');
    expect(JSON.stringify(ui)).not.toContain('re_live_key');
  });

  it('keeps the stored key when a masked value is echoed back, and clears on empty string', async () => {
    await enable();
    await setNotificationConfig({ enabled: true, resendApiKey: '●●●●_key', from: 'alerts@x.com', to: ['ops@x.com'] });
    expect(store.get('NOTIFICATIONS_CONFIG')).toContain('enc(re_live_key)'); // unchanged
    await setNotificationConfig({ enabled: true, resendApiKey: '', from: 'alerts@x.com', to: ['ops@x.com'] });
    expect(await getNotificationConfigForUI()).toMatchObject({ resendKeySet: false });
  });

  it('the master switch and per-event flags gate delivery: an event switched off sends nothing', async () => {
    await enable({ events: { keyBanned: false } });
    await notify(keyBannedMessage('openai', '●●●●1234'));
    expect(fetchMock).not.toHaveBeenCalled();

    // …and the master switch wins over an event that is on.
    await setNotificationConfig({ enabled: false, events: { keyBanned: true } });
    await notify(keyBannedMessage('openai', '●●●●5678'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notify', () => {
  it('sends one email and one webhook when armed and first-in-window', async () => {
    await enable();
    await notify(keyBannedMessage('openai', '●●●●1234'));
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://api.resend.com/emails');
    expect(urls).toContain('https://hooks.example.com/x');
  });

  it('coalesces: a repeat within the window sends nothing', async () => {
    await enable();
    const msg = keyBannedMessage('openai', '●●●●1234');
    await notify(msg);
    fetchMock.mockClear();
    await notify(msg); // same dedupe key
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when disabled or the event is off', async () => {
    await enable({ enabled: false });
    await notify(keyBannedMessage('openai', '●●●●1234'));
    expect(fetchMock).not.toHaveBeenCalled();
    // No *send* window is claimed when delivery is off — only the feed's own claim is taken.
    expect(redisSet).not.toHaveBeenCalledWith(
      'nexus:notify:sent:keyBanned:openai:●●●●1234', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('records to the in-app feed even when delivery is disabled (Phase 7.11)', async () => {
    // The point of the phase: email is off until an operator configures it, which is the default —
    // so a feed gated on delivery would leave the dashboard bell permanently empty. The alert is
    // still raised, still recorded, and simply never leaves the building.
    await enable({ enabled: false });
    const msg = keyBannedMessage('openai', '●●●●1234');
    await notify(msg);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordNotification).toHaveBeenCalledWith(msg, 3600);
  });

  it('records to the feed exactly once per notify, alongside a successful delivery', async () => {
    await enable();
    await notify(keyBannedMessage('openai', '●●●●1234'));
    expect(recordNotification).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled(); // both happen; neither depends on the other
  });

  it('never throws when a channel send fails', async () => {
    await enable();
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(notify(keyBannedMessage('openai', '●●●●9999'))).resolves.toBeUndefined();
  });

  it('only emails when the webhook is unset (and vice versa)', async () => {
    await enable({ webhookUrl: '' });
    await notify(keyBannedMessage('anthropic', '●●●●5678'));
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(['https://api.resend.com/emails']);
  });

  it('treats a non-2xx reply as a failure and releases the window so the next occurrence retries', async () => {
    await enable({ webhookUrl: '' }); // single channel — a 401 means nothing got through
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const msg = keyBannedMessage('openai', '●●●●1234');
    await notify(msg);
    expect(redisDel).toHaveBeenCalledWith('nexus:notify:sent:keyBanned:openai:●●●●1234'); // claim released

    // The key was rotated / fixed: a retry now goes out rather than being swallowed for the window.
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    fetchMock.mockClear();
    await notify(msg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the window (does not release) once a channel actually delivered', async () => {
    await enable(); // email + webhook; both 200 by default
    await notify(keyBannedMessage('groq', '●●●●abcd'));
    expect(redisDel).not.toHaveBeenCalled();
  });
});
