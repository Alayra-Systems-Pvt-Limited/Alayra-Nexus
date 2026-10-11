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

// ── The conformance fixture (P0.5c) ───────────────────────────────────────────────────────────
// One small, fixed world every storage adapter is tested against: two teams, three pools (one
// switched off), eight provider keys in every state routing cares about, and one setting. An
// adapter's harness writes exactly this into fresh storage; the checks then know every answer.
//
// Fixed timestamps, never the clock, so an ordering bug cannot hide behind two rows written in the
// same millisecond. Every key has a lastUsedAt: engines disagree on where a NULL sorts, and the
// core does not pin that order, so the fixture does not depend on it.

/** A caller's team. */
export interface FixtureTeam { id: string; name: string }

/** An API key a team calls the gateway with; usage rows are attributed to these. */
export interface FixtureTeamKey { id: string; teamId: string; name: string }

/** One provider pool, with every column the ports read. */
export interface FixtureProvider {
  id: string; name: string; slug: string; provider: string;
  baseUrl: string | null; authHeader: string; authPrefix: string | null;
  tier: string; preferredModel: string | null; extraHeaders: string | null;
  modelFetchUrl: string | null; modelIdPath: string;
  isActive: boolean; createdAt: Date;
}

/** One provider key. `encryptedKey` is opaque to the stores: they never decrypt. */
export interface FixtureKey {
  id: string; providerId: string; ownerTeamId: string | null;
  status: 'active' | 'cooling' | 'banned';
  maxUsers: number; rpmLimit: number; tpmLimit: number;
  encryptedKey: string; maskedKey: string;
  lastUsedAt: Date; coolingUntil: Date | null;
}

export interface CoreFixture {
  teams:     FixtureTeam[];
  teamKeys:  FixtureTeamKey[];
  providers: FixtureProvider[];
  keys:      FixtureKey[];
  settings:  { key: string; value: string }[];
}

// ── The data ──────────────────────────────────────────────────────────────────────────────────

/** The fixture's clock: every timestamp is an offset from here. */
export const T0 = new Date('2026-03-01T00:00:00.000Z');
export const hoursAfterT0 = (h: number): Date => new Date(T0.getTime() + h * 3_600_000);

const key = (k: Omit<FixtureKey, 'maxUsers' | 'rpmLimit' | 'tpmLimit'>): FixtureKey =>
  ({ maxUsers: 1000, rpmLimit: 60, tpmLimit: 100_000, ...k });

export const CONFORMANCE_FIXTURE: CoreFixture = {
  teams:    [{ id: 'team-a', name: 'Alpha' }, { id: 'team-b', name: 'Beta' }],
  teamKeys: [
    { id: 'tk-a', teamId: 'team-a', name: 'Alpha key' },
    { id: 'tk-b', teamId: 'team-b', name: 'Beta key' },
  ],
  providers: [
    {
      id: 'pool-openai', name: 'OpenAI main', slug: 'openai-main', provider: 'openai',
      baseUrl: null, authHeader: 'Authorization', authPrefix: 'Bearer ', tier: 'standard',
      preferredModel: null, extraHeaders: null, modelFetchUrl: null, modelIdPath: 'data[].id',
      isActive: true, createdAt: T0,
    },
    {
      id: 'pool-anthropic', name: 'Anthropic main', slug: 'anthropic-main', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com', authHeader: 'x-api-key', authPrefix: null, tier: 'premium',
      preferredModel: 'claude-x', extraHeaders: '{"anthropic-version":"2023-06-01"}',
      modelFetchUrl: 'https://api.anthropic.com/v1/models', modelIdPath: 'data[].id',
      isActive: true, createdAt: hoursAfterT0(1),
    },
    // Older than both, but switched off: never listed, never counted, never a BYOK slug.
    {
      id: 'pool-groq', name: 'Groq (retired)', slug: 'groq-old', provider: 'groq',
      baseUrl: null, authHeader: 'Authorization', authPrefix: 'Bearer ', tier: 'standard',
      preferredModel: 'llama-y', extraHeaders: null, modelFetchUrl: null, modelIdPath: 'data[].id',
      isActive: false, createdAt: hoursAfterT0(-24),
    },
  ],
  keys: [
    key({ id: 'key-shared-1', providerId: 'pool-openai', ownerTeamId: null, status: 'active',
      encryptedKey: 'enc:shared-1', maskedKey: 'sk-…1111', lastUsedAt: hoursAfterT0(2), coolingUntil: null }),
    key({ id: 'key-shared-2', providerId: 'pool-openai', ownerTeamId: null, status: 'cooling',
      encryptedKey: 'enc:shared-2', maskedKey: 'sk-…2222', lastUsedAt: hoursAfterT0(1), coolingUntil: hoursAfterT0(5) }),
    key({ id: 'key-shared-banned', providerId: 'pool-openai', ownerTeamId: null, status: 'banned',
      encryptedKey: 'enc:shared-banned', maskedKey: 'sk-…3333', lastUsedAt: T0, coolingUntil: null }),
    key({ id: 'key-team-a', providerId: 'pool-openai', ownerTeamId: 'team-a', status: 'active',
      encryptedKey: 'enc:team-a', maskedKey: 'sk-…4444', lastUsedAt: hoursAfterT0(3), coolingUntil: null }),
    key({ id: 'key-team-a-anthropic', providerId: 'pool-anthropic', ownerTeamId: 'team-a', status: 'banned',
      encryptedKey: 'enc:team-a-anthropic', maskedKey: 'sk-ant-…5555', lastUsedAt: T0, coolingUntil: null }),
    key({ id: 'key-team-a-groq', providerId: 'pool-groq', ownerTeamId: 'team-a', status: 'active',
      encryptedKey: 'enc:team-a-groq', maskedKey: 'gsk_…6666', lastUsedAt: T0, coolingUntil: null }),
    key({ id: 'key-anthropic', providerId: 'pool-anthropic', ownerTeamId: null, status: 'active',
      encryptedKey: 'enc:anthropic', maskedKey: 'sk-ant-…7777', lastUsedAt: hoursAfterT0(4), coolingUntil: null }),
    key({ id: 'key-cooling-late', providerId: 'pool-anthropic', ownerTeamId: null, status: 'cooling',
      encryptedKey: 'enc:cooling-late', maskedKey: 'sk-ant-…8888', lastUsedAt: hoursAfterT0(5), coolingUntil: hoursAfterT0(9) }),
  ],
  settings: [{ key: 'CACHE_ENABLED', value: 'true' }],
};
