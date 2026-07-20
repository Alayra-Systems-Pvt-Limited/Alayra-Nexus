/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import dataset from './dataset.json';

// This file is PUBLISHED — it ships inside a static demo anyone can open and read. It is produced by
// `npm run demo:fixtures`, which points at whatever gateway the operator's DATABASE_URL names, so
// nothing stops a future regeneration from running against a real deployment holding real keys.
// These tests are the guard against that: they fail loudly if a rebuild ever captures a secret,
// long before the file reaches a browser.
describe('demo dataset — safe to publish', () => {
  const json = JSON.stringify(dataset);

  const SECRET_FIELDS = [
    'encryptedKey', 'keyHash', 'passwordHash', 'totpSecret', 'clientSecret',
    'recoveryCode', 'sessionToken', 'apiToken', 'masterKey', 'plaintext',
  ];

  it.each(SECRET_FIELDS)('carries no %s field', (field) => {
    expect(json).not.toContain(`"${field}"`);
  });

  it('exposes provider keys only in masked form', () => {
    const keys = dataset.nexus.tiers.flatMap((t) => t.providers).flatMap((p) => p.keys);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      // A mask, by construction, contains the bullet the UI renders and no full credential.
      expect(k.maskedKey).toContain('•');
      expect(Object.keys(k)).not.toContain('encryptedKey');
    }
  });

  // A live provider credential is long and unbroken; a mask, an id and a slug are not. Anything
  // matching this shape in a published file deserves a human look before it ships.
  it('contains no credential-shaped strings', () => {
    const suspicious = json.match(/[A-Za-z0-9_-]{45,}/g) ?? [];
    expect(suspicious).toEqual([]);
  });

  it('carries no email addresses', () => {
    expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  });
});

describe('demo dataset — complete enough to render', () => {
  it('has every section the demo serves', () => {
    for (const key of ['overview', 'analytics', 'nexus', 'models', 'teams', 'teamStats',
                       'audit', 'notifications', 'health', 'cacheStats', 'cacheConfig']) {
      expect(dataset).toHaveProperty(key);
      expect(dataset[key as keyof typeof dataset]).not.toBeNull();
    }
  });

  // An empty demo is worse than none — it says the product does nothing.
  it('shows a gateway that has actually been used', () => {
    expect(dataset.overview.stats.totalRequests).toBeGreaterThan(1000);
    expect(dataset.overview.stats.totalCostUsd).toBeGreaterThan(0);
    expect(dataset.teams.length).toBeGreaterThan(1);
    expect(dataset.models.models.length).toBeGreaterThan(1);
    expect(dataset.audit.entries.length).toBeGreaterThan(10);
  });

  it('has all four analytics windows populated', () => {
    for (const period of ['today', '7d', '30d', '90d'] as const) {
      expect(dataset.analytics[period]).toBeTruthy();
    }
  });

  it('has per-team stats for every team and window', () => {
    for (const team of dataset.teams) {
      for (const period of ['today', '7d', '30d', '90d']) {
        expect(dataset.teamStats).toHaveProperty(`${team.id}:${period}`);
      }
    }
  });

  it('leaves some notifications unread, so the bell carries a badge', () => {
    expect(dataset.notifications.unreadCount).toBeGreaterThan(0);
  });
});
