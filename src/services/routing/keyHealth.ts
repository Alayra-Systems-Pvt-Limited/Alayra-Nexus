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

import { coreStores } from '../../core/stores';
import * as breaker from '../../lib/breaker';
import { forgetLastUsed } from '../../lib/lastUsed';
import { forgetKeyRow } from '../../lib/keyRowCache';
import type { Capability } from '../../lib/modelSelect';
import { keyBannedMessage, breakerOpenedMessage, tierExhaustedMessage } from '../../lib/notify';
import { notify } from '../notifications.service';

// ── Key health: cooldowns, bans, and the circuit breaker's outcome reporters ───

export async function getNextCooldownSeconds(): Promise<number> {
  const coolingUntil = await (await coreStores()).keys.nextCoolingUntil();
  if (!coolingUntil) return 60;
  return Math.max(5, Math.ceil((coolingUntil.getTime() - Date.now()) / 1000));
}

export async function banKey(keyId: string): Promise<void> {
  await (await coreStores()).keys.markBanned(keyId);
  forgetKeyRow(keyId);
  // A banned key is never routed to again, so its debounce entry is dead weight. Dropping it here
  // is what keeps that map bounded by the keys actually in service rather than by every key this
  // process has ever seen.
  forgetLastUsed(keyId);
}

/**
 * Flat, non-escalating cooldown. Used by the admin "cool" action and for 429s
 * (via reportRateLimit). Sets both the Redis breaker gate and the DB display
 * columns so routing and the dashboard agree.
 */
export async function coolKey(keyId: string, seconds = 60): Promise<void> {
  const until = new Date(Date.now() + seconds * 1000);
  await breaker.onRateLimit(keyId, seconds);
  await (await coreStores()).keys.markCooling(keyId, until);
  forgetKeyRow(keyId);
}

// ── Breaker outcome reporters ─────────────────────────────────────────────────
// Each pairs the Redis breaker state (authoritative for routing) with the DB
// status/coolingUntil columns (display only), so the dashboard stays truthful.
// These run on the rare failure/recovery events, never on the happy path's hot
// loop beyond a single onSuccess reset.

/** A healthy response: close the breaker; clear any lingering cooling display. */
export async function reportSuccess(keyId: string, wasProbe: boolean): Promise<void> {
  await breaker.onSuccess(keyId);
  // Only touch the DB when recovering a key that was actually cooling — a normal
  // closed-state success writes nothing.
  if (wasProbe) {
    await (await coreStores()).keys.markRecovered(keyId);
    forgetKeyRow(keyId);
  }
}

/** A 429: flat cooldown, no escalation, no strike. */
export async function reportRateLimit(keyId: string, seconds = breaker.RATE_LIMIT_COOLDOWN_SECONDS): Promise<void> {
  await coolKey(keyId, seconds);
}

/** A server-side failure (5xx / timeout / hung stream): strike or escalate. */
export async function reportServerFailure(keyId: string, wasProbe: boolean): Promise<void> {
  const { opened, cooldownSeconds } = await breaker.onServerFailure(keyId, wasProbe);
  if (opened) {
    const until = new Date(Date.now() + cooldownSeconds * 1000);
    await (await coreStores()).keys.markCooling(keyId, until);
    forgetKeyRow(keyId);
    void alertKeyEvent(keyId, 'opened', cooldownSeconds).catch(() => {});
  }
}

/** An auth failure (401/403): ban the key outright once the threshold is hit. */
export async function reportAuthFailure(keyId: string): Promise<void> {
  const { banned } = await breaker.onAuthFailure(keyId);
  if (banned) {
    await banKey(keyId);
    void alertKeyEvent(keyId, 'banned').catch(() => {});
  }
}

// Fire-and-forget operator alert (Phase 6.4) for a key-level failure. Never awaited by the reporters.
// The armed check that used to short-circuit here was removed in 7.11: it gated on the *email*
// config, so with delivery off (the default) the alert was never built and the in-app feed could
// never show that a key had died. notify() now records first and gates only delivery. The extra
// lookup this costs is for the display name of a key that just got banned or tripped its breaker —
// rare by construction, and off the request path.
async function alertKeyEvent(keyId: string, kind: 'banned' | 'opened', cooldownSeconds = 0): Promise<void> {
  const k = await (await coreStores()).keys.alertFacts(keyId);
  if (!k) return;
  await notify(kind === 'banned'
    ? keyBannedMessage(k.providerSlug, k.maskedKey)
    : breakerOpenedMessage(k.providerSlug, k.maskedKey, cooldownSeconds));
}

/**
 * Fire-and-forget operator alert (Phase 6.4b) for a request-path 503: every key able to
 * serve `capability` is exhausted, so the gateway is refusing that traffic. Called from the
 * `discoverBestPool → null` boundary in both the chat and non-chat handlers, giving one
 * uniform tap. `isolated` distinguishes a hard-isolated BYOK team from the shared pool.
 * Coalescing keeps a persistent outage to one message per window. Never awaited by the caller.
 *
 * This fires per refused request, so it is the one alert with real volume. It stays cheap: the
 * message builder is pure, and notify() coalesces on a Redis SET NX — a sustained outage costs one
 * set per 503 and one row per window, not a row per request. (7.11 removed the armed check that
 * used to gate this; it keyed off the email config, so a bell fed by it would never have seen the
 * gateway run out of capacity unless email happened to be set up.)
 */
export async function reportTierExhausted(capability: Capability, isolated: boolean): Promise<void> {
  await notify(tierExhaustedMessage(capability, isolated));
}
