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

// ── In-memory core stores (P0.5c) ─────────────────────────────────────────────────────────────
// The reference implementation of every storage port, held in plain arrays. It is what the
// conformance checks are proven against first, and what a host can install in its own tests or a
// demo. Not for production: nothing survives the process, and nothing is shared between processes.

import type {
  CoreStores, KeyRow, NotificationRow, ProviderCheckRow, ProviderRow, UsageRow,
} from '../ports';
import type { CoreFixture, FixtureKey, FixtureProvider } from './fixture';

export interface MemoryCoreStores {
  stores: CoreStores;
  /** Every notification recorded, oldest first. The sink port itself is write-only. */
  notifications: NotificationRow[];
  /** Every usage row stored, in insertion order, exactly as stored (teamId included). */
  usageRows(): UsageRow[];
}

const usable = (k: FixtureKey): boolean => k.status === 'active' || k.status === 'cooling';
const byTime = (a: Date, b: Date): number => a.getTime() - b.getTime();
/** The routing order every KeyStore promises: never used first, then oldest use, then id. */
const byRouting = (a: FixtureKey, b: FixtureKey): number => {
  if (a.lastUsedAt === null || b.lastUsedAt === null) {
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt === null ? -1 : 1;
  } else if (a.lastUsedAt.getTime() !== b.lastUsedAt.getTime()) {
    return byTime(a.lastUsedAt, b.lastUsedAt);
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// ── Projections: exactly the columns each port promises, nothing more ──

const keyRow = (k: FixtureKey): KeyRow => ({
  id: k.id, providerId: k.providerId, status: k.status, ownerTeamId: k.ownerTeamId,
  maxUsers: k.maxUsers, rpmLimit: k.rpmLimit, tpmLimit: k.tpmLimit, encryptedKey: k.encryptedKey,
});

const providerRow = (p: FixtureProvider): ProviderRow => ({
  id: p.id, baseUrl: p.baseUrl, provider: p.provider, authHeader: p.authHeader,
  authPrefix: p.authPrefix, tier: p.tier, preferredModel: p.preferredModel, extraHeaders: p.extraHeaders,
  nativeMessages: p.nativeMessages ?? null,
});

const checkRow = (p: FixtureProvider): ProviderCheckRow => ({
  baseUrl: p.baseUrl, provider: p.provider, authHeader: p.authHeader, authPrefix: p.authPrefix,
  extraHeaders: p.extraHeaders, modelFetchUrl: p.modelFetchUrl, modelIdPath: p.modelIdPath,
});

/** Stores over a private copy of `fixture`; the fixture itself is never mutated. */
export function createMemoryCoreStores(fixture: CoreFixture): MemoryCoreStores {
  const keys      = fixture.keys.map((k) => ({ ...k }));
  const providers = fixture.providers.map((p) => ({ ...p }));
  const teamOfKey = new Map(fixture.teamKeys.map((t) => [t.id, t.teamId]));
  const settings  = new Map(fixture.settings.map((s) => [s.key, s.value]));
  const usage     = new Map<string, UsageRow>();
  const notifications: NotificationRow[] = [];

  const keyById      = (id: string) => keys.find((k) => k.id === id);
  const providerById = (id: string) => providers.find((p) => p.id === id);
  const lru = (list: FixtureKey[]) => [...list].sort(byRouting);

  const stores: CoreStores = {
    // ── Keys ──
    keys: {
      listRoutable: async (providerId, ownerTeamId) => lru(keys.filter((k) =>
        k.providerId === providerId && k.ownerTeamId === ownerTeamId && usable(k))).map(keyRow),
      findRoutable: async (keyId) => { const k = keyById(keyId); return k ? keyRow(k) : null; },
      touchLastUsed: async (keyId, at) => { const k = keyById(keyId); if (k) k.lastUsedAt = at; },
      markBanned: async (keyId) => { const k = keyById(keyId); if (k) k.status = 'banned'; },
      markCooling: async (keyId, until) => {
        const k = keyById(keyId); if (k) { k.status = 'cooling'; k.coolingUntil = until; }
      },
      markRecovered: async (keyId) => {
        const k = keyById(keyId); if (k?.status === 'cooling') { k.status = 'active'; k.coolingUntil = null; }
      },
      nextCoolingUntil: async () => {
        const due = keys.filter((k) => k.status === 'cooling' && k.coolingUntil)
          .map((k) => k.coolingUntil as Date).sort(byTime);
        return due[0] ?? null;
      },
      alertFacts: async (keyId) => {
        const k = keyById(keyId); const p = k && providerById(k.providerId);
        return k && p ? { maskedKey: k.maskedKey, providerSlug: p.slug } : null;
      },
      countOwnedUsable: async (teamId) => keys.filter((k) => k.ownerTeamId === teamId && usable(k)).length,
      ownedProviderSlugs: async (teamId) => new Set(keys
        .filter((k) => k.ownerTeamId === teamId && usable(k))
        .map((k) => providerById(k.providerId))
        .filter((p): p is FixtureProvider => !!p && p.isActive)
        .map((p) => p.provider)),
      countUsable: async () => keys.filter(usable).length,
      listStates: async () => keys.map((k) => ({ status: k.status, coolingUntil: k.coolingUntil })),
      findForCheck: async (keyId) => {
        const k = keyById(keyId); const p = k && providerById(k.providerId);
        return k && p ? { encryptedKey: k.encryptedKey, provider: checkRow(p) } : null;
      },
    },

    // ── Provider pools ──
    providers: {
      listActive: async () => providers.filter((p) => p.isActive)
        .sort((a, b) => byTime(a.createdAt, b.createdAt)).map(providerRow),
      listPreferredModelPools: async () => providers
        .filter((p) => p.isActive && p.preferredModel !== null)
        .map((p) => ({ provider: p.provider, preferredModel: p.preferredModel, tier: p.tier, name: p.name })),
      countActive: async () => providers.filter((p) => p.isActive).length,
      findForCheck: async (providerId) => {
        const p = providerById(providerId);
        if (!p) return null;
        const active = lru(keys.filter((k) => k.providerId === providerId && k.status === 'active'));
        return { ...checkRow(p), activeKey: active[0]?.encryptedKey ?? null };
      },
    },

    // ── Usage: idempotent on id, as the pipeline's retries require ──
    // A row is the team's by its own `teamId` when it carries one (P1.1), else through its team key —
    // so a host with no team keys at all can still use these stores for budgets in its tests.
    usage: {
      insertBatch: async (rows) => { for (const r of rows) if (!usage.has(r.id)) usage.set(r.id, { ...r }); },
      teamSpendSince: async (teamId, since) => [...usage.values()]
        .filter((u) => (u.teamId ?? (u.nexusTeamKeyId !== null ? teamOfKey.get(u.nexusTeamKeyId) : undefined)) === teamId
          && u.createdAt.getTime() >= since.getTime())
        .reduce((sum, u) => sum + u.estimatedUsd, 0),
    },

    // ── Settings ──
    settings: {
      get: async (k) => settings.get(k) ?? null,
      set: async (k, v) => { settings.set(k, v); },
    },

    // ── Notifications ──
    notifications: {
      record: async (row) => { notifications.push({ ...row }); },
    },
  };

  return { stores, notifications, usageRows: () => [...usage.values()].map((u) => ({ ...u })) };
}
