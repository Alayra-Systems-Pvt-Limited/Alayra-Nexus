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

// ── KeyStore conformance (P0.5c) ──────────────────────────────────────────────────────────────
// What routing relies on from a key store, checked against the fixture. Each check gets fresh
// storage from the harness, so the order the checks run in never matters.

import assert from 'node:assert/strict';
import type { KeyRow } from '../ports';
import { CONFORMANCE_FIXTURE as F, hoursAfterT0 } from './fixture';
import type { ConformanceCase } from './conformanceTypes';

const ids = (rows: KeyRow[]): string[] => rows.map((r) => r.id);
function fixtureKey(id: string) {
  const k = F.keys.find((row) => row.id === id);
  if (!k) throw new Error(`the conformance fixture has no key ${id}`);
  return k;
}

export const keyStoreCases: ConformanceCase[] = [
  // ── Routing reads ──
  {
    name: 'keys.listRoutable: the shared pool, usable keys only, least recently used first',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(ids(await s.keys.listRoutable('pool-openai', null)), ['key-shared-2', 'key-shared-1']);
    },
  },
  {
    name: 'keys.listRoutable: a team sees only its own keys, and never a banned one',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(ids(await s.keys.listRoutable('pool-openai', 'team-a')), ['key-team-a']);
      assert.deepEqual(await s.keys.listRoutable('pool-anthropic', 'team-a'), []);
    },
  },
  {
    name: 'keys.findRoutable: exactly the routing projection, ciphertext untouched; null when gone',
    run: async (h) => {
      const s = await h.setup(F);
      const k = fixtureKey('key-team-a');
      assert.deepEqual(await s.keys.findRoutable('key-team-a'), {
        id: k.id, providerId: k.providerId, status: k.status, ownerTeamId: k.ownerTeamId,
        maxUsers: k.maxUsers, rpmLimit: k.rpmLimit, tpmLimit: k.tpmLimit, encryptedKey: k.encryptedKey,
      });
      assert.equal(await s.keys.findRoutable('no-such-key'), null);
    },
  },

  // ── State writes ──
  {
    name: 'keys.touchLastUsed: a key just used moves to the back of the order',
    run: async (h) => {
      const s = await h.setup(F);
      await s.keys.touchLastUsed('key-shared-2', hoursAfterT0(10));
      assert.deepEqual(ids(await s.keys.listRoutable('pool-openai', null)), ['key-shared-1', 'key-shared-2']);
    },
  },
  {
    name: 'keys.markBanned: a banned key stops routing and stops counting as usable',
    run: async (h) => {
      const s = await h.setup(F);
      await s.keys.markBanned('key-shared-1');
      assert.deepEqual(ids(await s.keys.listRoutable('pool-openai', null)), ['key-shared-2']);
      assert.equal((await s.keys.findRoutable('key-shared-1'))?.status, 'banned');
      assert.equal(await s.keys.countUsable(), 5);
    },
  },
  {
    name: 'keys.markCooling: a cooling key still routes, and its deadline is the next one due',
    run: async (h) => {
      const s = await h.setup(F);
      await s.keys.markCooling('key-shared-1', hoursAfterT0(3));
      assert.equal((await s.keys.findRoutable('key-shared-1'))?.status, 'cooling');
      assert.deepEqual(ids(await s.keys.listRoutable('pool-openai', null)), ['key-shared-2', 'key-shared-1']);
      assert.deepEqual(await s.keys.nextCoolingUntil(), hoursAfterT0(3));
    },
  },
  {
    name: 'keys.markRecovered: cooling becomes active with no deadline; active and banned keys are untouched',
    run: async (h) => {
      const s = await h.setup(F);
      await s.keys.markRecovered('key-shared-2');
      await s.keys.markRecovered('key-shared-1');
      await s.keys.markRecovered('key-shared-banned');
      assert.equal((await s.keys.findRoutable('key-shared-2'))?.status, 'active');
      assert.equal((await s.keys.findRoutable('key-shared-1'))?.status, 'active');
      assert.equal((await s.keys.findRoutable('key-shared-banned'))?.status, 'banned');
      assert.deepEqual(await s.keys.nextCoolingUntil(), hoursAfterT0(9));   // only the other cooling key is left
    },
  },

  // ── Operator facts ──
  {
    name: 'keys.nextCoolingUntil: the soonest deadline, or null when nothing is cooling',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(await s.keys.nextCoolingUntil(), hoursAfterT0(5));
      await s.keys.markRecovered('key-shared-2');
      await s.keys.markRecovered('key-cooling-late');
      assert.equal(await s.keys.nextCoolingUntil(), null);
    },
  },
  {
    name: 'keys.alertFacts: the masked key and its pool slug; null when gone',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(await s.keys.alertFacts('key-anthropic'), { maskedKey: 'sk-ant-…7777', providerSlug: 'anthropic-main' });
      assert.equal(await s.keys.alertFacts('no-such-key'), null);
    },
  },
  {
    name: 'keys.listStates: one row per key, status and cooling deadline only',
    run: async (h) => {
      const s = await h.setup(F);
      const rows = await s.keys.listStates();
      const key = (r: { status: string; coolingUntil: Date | null }) => `${r.status}@${r.coolingUntil?.toISOString() ?? '-'}`;
      assert.deepEqual(rows.map(key).sort(), F.keys.map(key).sort());
      for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['coolingUntil', 'status']);
    },
  },
  {
    name: 'keys.findForCheck: the key ciphertext with its pool; null when gone',
    run: async (h) => {
      const s = await h.setup(F);
      assert.deepEqual(await s.keys.findForCheck('key-anthropic'), {
        encryptedKey: 'enc:anthropic',
        provider: {
          baseUrl: 'https://api.anthropic.com', provider: 'anthropic', authHeader: 'x-api-key', authPrefix: null,
          extraHeaders: '{"anthropic-version":"2023-06-01"}', modelFetchUrl: 'https://api.anthropic.com/v1/models',
          modelIdPath: 'data[].id',
        },
      });
      assert.equal(await s.keys.findForCheck('no-such-key'), null);
    },
  },

  // ── BYOK and catalog counts ──
  {
    name: 'keys counts: usable keys overall and per team; BYOK slugs skip banned keys and switched-off pools',
    run: async (h) => {
      const s = await h.setup(F);
      assert.equal(await s.keys.countUsable(), 6);
      assert.equal(await s.keys.countOwnedUsable('team-a'), 2);
      assert.equal(await s.keys.countOwnedUsable('team-b'), 0);
      assert.deepEqual([...await s.keys.ownedProviderSlugs('team-a')], ['openai']);
      assert.deepEqual([...await s.keys.ownedProviderSlugs('team-b')], []);
    },
  },
];
