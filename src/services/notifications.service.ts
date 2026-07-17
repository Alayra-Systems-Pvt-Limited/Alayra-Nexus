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

// ── Operator notifications: config + delivery (Phase 6.4) ─────────────────────
// The side-effect half of the feature: reads/writes the (encrypted) config, and turns a
// NotifyMessage into at most one email + one webhook per window. Every path is wrapped so
// a mail outage, a bad key, or a hung endpoint can never throw into — or slow — a caller.
// Off by default; nothing is sent until an operator enables it and adds a channel.

import { getSetting, setSetting } from './settings.service';
import { safeFetch } from '../lib/safeFetch';
import { redis }                  from '../lib/redis';
import { recordNotification }     from './notificationFeed.service';
import { encrypt, decrypt, maskKey } from '../lib/encryption';
import {
  normalizeNotificationConfig, coalesceRedisKey,
  type NotificationConfig, type NotifyMessage, type NotifyEventType,
} from '../lib/notify';

const SETTING_KEY  = 'NOTIFICATIONS_CONFIG';
const RESEND_URL   = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = parseInt(process.env.NOTIFY_SEND_TIMEOUT_MS ?? '8000', 10);

/** The stored config, normalized. `resendApiKey` is still ciphertext here. */
async function readConfig(): Promise<NotificationConfig> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return normalizeNotificationConfig(null);
  try { return normalizeNotificationConfig(JSON.parse(raw)); }
  catch { return normalizeNotificationConfig(null); }
}

/** Decrypt the stored Resend key; never throw (a rotated master key must not crash sends). */
function safeDecrypt(ciphertext: string): string {
  if (!ciphertext) return '';
  try { return decrypt(ciphertext); } catch { return ''; }
}

/** The masked placeholder the UI shows for a set key; a PUT echoing it means "unchanged". */
function looksMasked(v: string): boolean { return v.includes('●'); }

/** Config for the dashboard: the key is never returned, only whether one is set + its mask. */
export async function getNotificationConfigForUI(): Promise<{
  enabled: boolean; from: string; to: string[]; webhookUrl: string;
  events: Record<NotifyEventType, boolean>; windowSeconds: number;
  resendKeySet: boolean; resendKeyMasked: string;
}> {
  const c = await readConfig();
  const plain = safeDecrypt(c.resendApiKey);
  return {
    enabled: c.enabled, from: c.from, to: c.to, webhookUrl: c.webhookUrl,
    events: c.events, windowSeconds: c.windowSeconds,
    resendKeySet: !!c.resendApiKey, resendKeyMasked: plain ? maskKey(plain) : '',
  };
}

export interface NotificationConfigInput {
  enabled?:      boolean;
  resendApiKey?: string;   // omit or send the masked value to keep the stored key
  from?:         string;
  to?:           string[];
  webhookUrl?:   string;
  events?:       Partial<Record<NotifyEventType, boolean>>;
  windowSeconds?: number;
}

/** Persist config. A new plaintext key is encrypted; a masked/omitted key is left as-is;
 *  an explicit empty string clears it. The stored blob only ever holds ciphertext. */
export async function setNotificationConfig(input: NotificationConfigInput): Promise<void> {
  const existing = await readConfig();

  let resendApiKey = existing.resendApiKey;
  if (typeof input.resendApiKey === 'string') {
    if (input.resendApiKey === '') resendApiKey = '';                       // explicit clear
    else if (!looksMasked(input.resendApiKey)) resendApiKey = encrypt(input.resendApiKey.trim());
    // a masked echo falls through: keep the existing ciphertext
  }

  const merged = normalizeNotificationConfig({
    enabled:      input.enabled ?? existing.enabled,
    resendApiKey,
    from:         input.from ?? existing.from,
    to:           input.to ?? existing.to,
    webhookUrl:   input.webhookUrl ?? existing.webhookUrl,
    events:       { ...existing.events, ...(input.events ?? {}) },
    windowSeconds: input.windowSeconds ?? existing.windowSeconds,
  });
  await setSetting(SETTING_KEY, JSON.stringify(merged));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    // A 2xx is the only "delivered". A rejected key (401), a bad sender (422), or a webhook
    // 5xx must surface as a rejection so notify() can tell a real failure from a no-op and
    // decline to burn the coalescing window on an alert that never actually went out.
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Each channel reports whether it actually sent ('sent') or was not configured ('skipped'),
 *  and throws when a configured send fails — the three outcomes notify() needs to decide
 *  whether the once-per-window claim should stand or be released for a retry. */
type ChannelResult = 'sent' | 'skipped';

async function sendEmail(c: NotificationConfig, msg: NotifyMessage): Promise<ChannelResult> {
  const apiKey = safeDecrypt(c.resendApiKey);
  if (!apiKey || !c.from || c.to.length === 0) return 'skipped'; // email channel not configured
  await postJson(RESEND_URL, { Authorization: `Bearer ${apiKey}` }, {
    from: c.from, to: c.to, subject: msg.title, text: msg.body,
  });
  return 'sent';
}

async function sendWebhook(c: NotificationConfig, msg: NotifyMessage): Promise<ChannelResult> {
  if (!c.webhookUrl) return 'skipped'; // webhook channel not configured
  await postJson(c.webhookUrl, {}, { type: msg.type, title: msg.title, body: msg.body });
  return 'sent';
}

/**
 * Raise an alert: record it in the in-app feed, and deliver at most one email and one webhook per
 * `dedupeKey` per window. Coalescing is a Redis SET NX with the window as its TTL — the first caller
 * to claim the key sends, and everyone else within the window is a no-op, so a flapping key produces
 * one message, not a storm. Fully guarded: a disabled feature, an unconfigured channel, or a failed
 * send all resolve quietly. Never on the request path — callers invoke this fire-and-forget.
 *
 * Recording comes first and is **not** gated by the config (Phase 7.11). Email delivery is off until
 * an operator sets up a channel, which is the default, so gating the feed on it would leave the
 * dashboard bell permanently empty on a fresh install — the alert would be raised and thrown away.
 * The `enabled` switch and the per-event flags therefore mean "send this out of the building", not
 * "notice this at all".
 *
 * The send claim is taken *before* the send, which is what makes coalescing atomic — but it means a
 * send that then fails would silently swallow the whole window. So when a configured channel
 * was actually attempted and nothing got through, the claim is released, letting the next
 * occurrence retry rather than being lost until the window expires. A purely skipped
 * (unconfigured) send keeps the claim, since there is nothing to retry and no point thrashing.
 */
export async function notify(msg: NotifyMessage): Promise<void> {
  try {
    const c = await readConfig();

    // The feed: always, and on its own claim key so a released send-claim cannot duplicate an
    // entry that is already sitting in the bell.
    await recordNotification(msg, c.windowSeconds);

    if (!c.enabled || !c.events[msg.type]) return;

    const key = coalesceRedisKey(msg.dedupeKey);
    const claimed = await redis.set(key, '1', 'EX', c.windowSeconds, 'NX');
    if (claimed === null) return; // already alerted this window

    // Both channels are attempted; one failing never blocks the other, and neither throws out.
    const results   = await Promise.allSettled([sendEmail(c, msg), sendWebhook(c, msg)]);
    const delivered = results.some((r) => r.status === 'fulfilled' && r.value === 'sent');
    const failed    = results.some((r) => r.status === 'rejected');
    if (!delivered && failed) await redis.del(key).catch(() => {}); // nothing got through — allow a retry
  } catch { /* notifications must never disturb the caller */ }
}
