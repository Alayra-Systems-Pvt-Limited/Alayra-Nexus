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

// ── Core stores conformance (P0.5c) ───────────────────────────────────────────────────────────
// The checks every storage adapter must pass before a host may install it: the open-source Prisma
// adapters on SQLite and Postgres, the hosted gateway's tenant stores, and the in-memory reference.
// Written with node:assert only, so a host runs them under whatever test runner it already has:
//
//   for (const c of coreStoresConformance) test(c.name, () => c.run(harness));

import assert from 'node:assert/strict';
import type { UsageRow } from '../ports';
import { CONFORMANCE_FIXTURE as F, NEVER_USED_FIXTURE, T0, hoursAfterT0 } from './fixture';
import { keyStoreCases } from './conformanceKeys';
import type { ConformanceCase, CoreStoresHarness } from './conformanceTypes';

/** The team each fixture team key belongs to: a row's teamId always agrees with its key (P1.1). */
const TEAM_OF_KEY: Record<string, string> = Object.fromEntries(F.teamKeys.map((k) => [k.id, k.teamId]));

/** A usage row with every column filled; only what a check varies is passed in. */
function usageRow(id: string, nexusTeamKeyId: string | null, estimatedUsd: number, createdAt: Date): UsageRow {
  return {
    id, sessionId: `s-${id}`, modelId: 'gpt-x', modelName: 'gpt-x', provider: 'openai',
    inputTokens: 10, outputTokens: 5, totalTokens: 15, unit: 'token', quantity: 0,
    estimatedUsd, outcome: 'success', latencyMs: 120, cached: false, savedUsd: 0,
    nexusTeamKeyId, teamId: nexusTeamKeyId === null ? null : TEAM_OF_KEY[nexusTeamKeyId] ?? null, createdAt,
  };
}

// Team A spends 1.25 + 0.75 + 0.50 from T0 on (the 0.50 lands exactly on T0: the window is
// inclusive). Its 5.00 before T0, team B's 9.00 and the unattributed 3.00 never count.
const USAGE: UsageRow[] = [
  usageRow('u-1', 'tk-a', 1.25, hoursAfterT0(24)),
  usageRow('u-2', 'tk-a', 0.75, hoursAfterT0(48)),
  usageRow('u-3', 'tk-a', 0.50, T0),
  usageRow('u-4', 'tk-a', 5.00, hoursAfterT0(-24)),
  usageRow('u-5', 'tk-b', 9.00, hoursAfterT0(24)),
  usageRow('u-6', null,   3.00, hoursAfterT0(24)),
];

// ── Provider pools ────────────────────────────────────────────────────────────────────────────

const providerCases: ConformanceCase[] = [
  {
    name: 'providers.listActive: active pools only, oldest first, exactly the routing projection',
    run: async (h) => {
      const s = await h.setup(F);
      const rows = await s.providers.listActive();
      assert.deepEqual(rows.map((r) => r.id), ['pool-openai', 'pool-anthropic']);
      assert.deepEqual(rows[1], {
        id: 'pool-anthropic', baseUrl: 'https://api.anthropic.com', provider: 'anthropic',
        authHeader: 'x-api-key', authPrefix: null, tier: 'premium', preferredModel: 'claude-x',
        extraHeaders: '{"anthropic-version":"2023-06-01"}', nativeMessages: '{"allow":["speed"]}',
      });
    },
  },
  {
    name: 'providers.listPreferredModelPools: active pools that pin a model; a switched-off pool never does',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(await s.providers.listPreferredModelPools(), [
        { provider: 'anthropic', preferredModel: 'claude-x', tier: 'premium', name: 'Anthropic main' },
      ]);
    },
  },
  {
    name: 'providers.countActive: switched-off pools are not counted',
    run: async (h) => {
      const s = await h.setup(F);
      assert.equal(await s.providers.countActive(), 2);
    },
  },
  {
    name: 'providers.findForCheck: the check columns and the least recently used active key, of any owner',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(await s.providers.findForCheck('pool-openai'), {
        baseUrl: null, provider: 'openai', authHeader: 'Authorization', authPrefix: 'Bearer ',
        extraHeaders: null, modelFetchUrl: null, modelIdPath: 'data[].id', activeKey: 'enc:shared-1',
      });
      assert.equal(await s.providers.findForCheck('no-such-pool'), null);
    },
  },
  {
    name: 'providers.findForCheck: a never-used active key is the one checked',
    run: async (h) => {
      const s = await h.setup(NEVER_USED_FIXTURE);
      assert.equal((await s.providers.findForCheck('pool-openai'))?.activeKey, 'enc:new-a');
    },
  },
  {
    name: 'providers.findForCheck: no active key left means activeKey is null, not an error',
    run: async (h) => {
      const s = await h.setup(F);
      await s.keys.markBanned('key-anthropic');                  // the pool's only active key
      assert.equal((await s.providers.findForCheck('pool-anthropic'))?.activeKey, null);
    },
  },
];

// ── Usage, settings, notifications ────────────────────────────────────────────────────────────

const recordCases: ConformanceCase[] = [
  {
    name: "usage.teamSpendSince: the team's own rows from `since` on, inclusive",
    run: async (h) => {
      const s = await h.setup(F);
      await s.usage.insertBatch(USAGE);
      assert.equal(await s.usage.teamSpendSince('team-a', T0), 2.5);
      assert.equal(await s.usage.teamSpendSince('team-b', T0), 9);
      assert.equal(await s.usage.teamSpendSince('team-a', hoursAfterT0(36)), 0.75);
    },
  },
  {
    name: 'usage.insertBatch: idempotent on id, so a retried batch is never counted twice',
    run: async (h) => {
      const s = await h.setup(F);
      await s.usage.insertBatch(USAGE.slice(0, 2));
      await s.usage.insertBatch(USAGE);                           // u-1 and u-2 again, with the rest
      assert.equal(await s.usage.teamSpendSince('team-a', T0), 2.5);
    },
  },
  {
    // P1.1. Every store must accept the column; one that keeps it must hand it back unchanged. A store
    // with nowhere to keep it (no `usageRows` in its harness) is held to the first half only.
    name: "usage.insertBatch: a row's teamId is accepted, and kept by a store that keeps it",
    run: async (h) => {
      const s = await h.setup(F);
      await s.usage.insertBatch(USAGE);
      assert.equal(await s.usage.teamSpendSince('team-a', T0), 2.5);
      if (!h.usageRows) return;
      const stored = new Map((await h.usageRows()).map((r) => [r.id, r.teamId]));
      assert.deepEqual(USAGE.map((r) => stored.get(r.id)), USAGE.map((r) => r.teamId));
      assert.deepEqual(USAGE.map((r) => r.teamId), ['team-a', 'team-a', 'team-a', 'team-a', 'team-b', null]);
    },
  },
  {
    // 1.8.0. The optional token kinds are additive: every store must accept a row that carries them
    // (a strict store that rejects an unknown field would fail every usage flush), spend must not move,
    // and a store that hands rows back must hand these back unchanged.
    name: 'usage.insertBatch: the optional token kinds are accepted, never priced, and kept by a store that keeps them',
    run: async (h) => {
      const s = await h.setup(F);
      const kinds = { cachedInputTokens: 6, cacheWriteTokens: 3, cacheWrite5mTokens: 1, cacheWrite1hTokens: 2, cacheMissTokens: 4, reasoningTokens: 0 };
      const rows = USAGE.map((r, i) => (i % 2 === 0 ? { ...r, ...kinds } : r));
      await s.usage.insertBatch(rows);
      assert.equal(await s.usage.teamSpendSince('team-a', T0), 2.5);
      if (!h.usageRows) return;
      const stored = new Map((await h.usageRows()).map((r) => [r.id, r]));
      for (const [i, r] of rows.entries()) {
        const got = stored.get(r.id);
        for (const k of Object.keys(kinds) as Array<keyof typeof kinds>) assert.equal(got?.[k] ?? null, i % 2 === 0 ? kinds[k] : null);
      }
    },
  },
  {
    name: 'usage.teamSpendSince: a team with no usage spends 0',
    run: async (h) => {
      const s = await h.setup(F);
      assert.equal(await s.usage.teamSpendSince('team-b', T0), 0);
    },
  },
  {
    name: 'settings: null when never set, then the latest value written',
    run: async (h) => {
      const s = await h.setup(F);
      assert.equal(await s.settings.get('CACHE_ENABLED'), 'true');
      assert.equal(await s.settings.get('NEVER_SET'), null);
      await s.settings.set('ROUTING_COST_WEIGHT', '0.3');
      await s.settings.set('ROUTING_COST_WEIGHT', '0.7');
      assert.equal(await s.settings.get('ROUTING_COST_WEIGHT'), '0.7');
    },
  },
  {
    name: 'notifications.record: the row is stored as given',
    run: async (h) => {
      const s = await h.setup(F);
      const row = {
        id: 'n-1', type: 'keyBanned', severity: 'critical', title: 'A key was banned',
        body: 'sk-…1111 failed authentication twice.', section: 'nexus', dedupeKey: 'keyBanned:key-shared-1',
      };
      await s.notifications.record(row);
      const stored = await h.notifications();
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0], row);
    },
  },
];

/** Every check, in a stable order. */
export const coreStoresConformance: readonly ConformanceCase[] = [...keyStoreCases, ...providerCases, ...recordCases];

/** Runs every check in turn and returns the failures (an empty list means the adapter conforms). */
export async function runCoreStoresConformance(
  harness: CoreStoresHarness,
): Promise<{ name: string; error: unknown }[]> {
  const failures: { name: string; error: unknown }[] = [];
  for (const c of coreStoresConformance) {
    try { await c.run(harness); } catch (error) { failures.push({ name: c.name, error }); }
  }
  return failures;
}
