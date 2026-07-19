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

import { describe, it, expect } from 'vitest';
import {
  normalizeNotificationConfig, keyBannedMessage, breakerOpenedMessage, adminLockoutMessage,
  budgetThresholdCrossed, budgetThresholdMessage, tierExhaustedMessage, sectionFor,
  coalesceRedisKey, DEFAULT_WINDOW_SECONDS, MIN_WINDOW_SECONDS, NOTIFY_EVENTS,
} from './notify';

describe('normalizeNotificationConfig', () => {
  it('defaults an empty/absent config to off with every event on', () => {
    const c = normalizeNotificationConfig(null);
    expect(c.enabled).toBe(false);
    expect(c.resendApiKey).toBe('');
    expect(c.to).toEqual([]);
    expect(c.windowSeconds).toBe(DEFAULT_WINDOW_SECONDS);
    for (const e of NOTIFY_EVENTS) expect(c.events[e]).toBe(true);
  });

  it('clamps the window to the floor and trims/filters recipients', () => {
    const c = normalizeNotificationConfig({ windowSeconds: 5, to: [' a@b.com ', '', 'c@d.com'] });
    expect(c.windowSeconds).toBe(MIN_WINDOW_SECONDS);
    expect(c.to).toEqual(['a@b.com', 'c@d.com']);
  });

  it('treats a missing event flag as on but an explicit false as off', () => {
    const c = normalizeNotificationConfig({ events: { keyBanned: false } });
    expect(c.events.keyBanned).toBe(false);
    expect(c.events.breakerOpened).toBe(true); // absent → on
  });

  it('coerces junk types without throwing', () => {
    const c = normalizeNotificationConfig({ enabled: 'yes', to: 'nope', from: 42, windowSeconds: 'x' });
    expect(c.enabled).toBe(false);       // only boolean true enables
    expect(c.to).toEqual([]);
    expect(c.from).toBe('');
    expect(c.windowSeconds).toBe(DEFAULT_WINDOW_SECONDS);
  });
});

describe('message builders', () => {
  it('build a typed message with a stable, occurrence-scoped dedupe key', () => {
    const banned = keyBannedMessage('openai', '●●●●1234');
    expect(banned.type).toBe('keyBanned');
    expect(banned.dedupeKey).toBe('keyBanned:openai:●●●●1234');
    expect(banned.title).toContain('openai');

    const opened = breakerOpenedMessage('groq', '●●●●abcd', 30);
    expect(opened.type).toBe('breakerOpened');
    expect(opened.dedupeKey).toBe('breakerOpened:groq:●●●●abcd');
    expect(opened.body).toContain('30s');

    const lock = adminLockoutMessage('203.0.113.7');
    expect(lock.type).toBe('adminLockout');
    expect(lock.dedupeKey).toBe('adminLockout:203.0.113.7');
  });

  it('namespaces the coalesce Redis key', () => {
    expect(coalesceRedisKey('keyBanned:openai:x')).toBe('nexus:notify:sent:keyBanned:openai:x');
  });
});

describe('budgetThresholdCrossed (Phase 6.4b)', () => {
  it('detects the 80% crossing exactly once, on the step that vaults it', () => {
    expect(budgetThresholdCrossed(7.9, 8.1, 10)).toBe(80);  // 79% → 81%
    expect(budgetThresholdCrossed(8.1, 8.5, 10)).toBeNull(); // already past 80%, not yet 100%
  });

  it('detects the 100% crossing and reports the higher threshold when one step vaults both', () => {
    expect(budgetThresholdCrossed(9.5, 10, 10)).toBe(100);
    expect(budgetThresholdCrossed(1, 11, 10)).toBe(100);    // 10% → 110% in one large request
  });

  it('stays silent below 80%, when already over 100%, and with no cap', () => {
    expect(budgetThresholdCrossed(1, 2, 10)).toBeNull();
    expect(budgetThresholdCrossed(10.1, 12, 10)).toBeNull(); // already over — one alert, not per request
    expect(budgetThresholdCrossed(1, 100, 0)).toBeNull();    // budgetUsd 0 / unset
  });
});

describe('budgetThreshold + tierExhausted message builders (Phase 6.4b)', () => {
  it('scopes the budget dedupe key to team, window and percentage', () => {
    const m = budgetThresholdMessage({
      teamId: 't1', teamName: 'Acme', pct: 80,
      spendUsd: 8.4, budgetUsd: 10, period: 'monthly', windowId: '2026-07',
    });
    expect(m.type).toBe('budgetThreshold');
    expect(m.dedupeKey).toBe('budgetThreshold:t1:2026-07:80');
    expect(m.title).toContain('Acme');
    expect(m.body).toContain('80%');

    const full = budgetThresholdMessage({
      teamId: 't1', teamName: 'Acme', pct: 100,
      spendUsd: 10, budgetUsd: 10, period: 'monthly', windowId: '2026-07',
    });
    expect(full.dedupeKey).toBe('budgetThreshold:t1:2026-07:100');
    expect(full.body).toContain('429'); // cut off
  });

  it('distinguishes an isolated tier-exhaustion from the shared pool', () => {
    const shared = tierExhaustedMessage('chat', false);
    expect(shared.type).toBe('tierExhausted');
    expect(shared.dedupeKey).toBe('tierExhausted:chat:shared');

    const isolated = tierExhaustedMessage('embedding', true);
    expect(isolated.dedupeKey).toBe('tierExhausted:embedding:isolated');
    expect(isolated.body).toContain('fall-back is disabled');
  });
});

describe('severity (Phase 7.16c)', () => {
  it('marks actively-broken and under-attack events critical', () => {
    expect(keyBannedMessage('openai', '●●●●1234').severity).toBe('critical');
    expect(adminLockoutMessage('203.0.113.7').severity).toBe('critical');
    expect(tierExhaustedMessage('chat', false).severity).toBe('critical');
  });

  it('marks a heading-that-way event a warning', () => {
    expect(breakerOpenedMessage('groq', '●●●●abcd', 30).severity).toBe('warning');
  });

  it('escalates a budget alert from warning at 80% to critical at 100%', () => {
    const base = { teamId: 't1', teamName: 'Acme', spendUsd: 8, budgetUsd: 10, period: 'monthly', windowId: '2026-07' } as const;
    expect(budgetThresholdMessage({ ...base, pct: 80 }).severity).toBe('warning');
    expect(budgetThresholdMessage({ ...base, pct: 100 }).severity).toBe('critical');
  });
});

describe('sectionFor (Phase 7.11)', () => {
  it('sends each alert to the section where it can actually be acted on', () => {
    expect(sectionFor('keyBanned')).toBe('nexus');        // replace the dead credential
    expect(sectionFor('breakerOpened')).toBe('nexus');    // the pool whose key is cooling
    expect(sectionFor('tierExhausted')).toBe('nexus');    // add keys / wait out the cooldown
    expect(sectionFor('adminLockout')).toBe('security');  // sign-in policy + second factor
    expect(sectionFor('budgetThreshold')).toBe('teams');  // the team that hit its cap
  });

  it('has a destination for every event, so a new one cannot ship without a home', () => {
    for (const e of NOTIFY_EVENTS) expect(sectionFor(e)).toBeTruthy();
  });
});
