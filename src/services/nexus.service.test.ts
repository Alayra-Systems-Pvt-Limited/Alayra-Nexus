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

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Two providers on the same tier and four keys: two shared, two owned by team-a.
// `encryptedKey` is irrelevant here — decrypt is stubbed.

type Key = { id: string; providerId: string; encryptedKey: string; ownerTeamId: string | null; status: string; rpmLimit: number; tpmLimit: number };

const key =(id: string, ownerTeamId: string | null, status = 'active'): Key =>
  ({ id, providerId: 'p1', encryptedKey: `enc-${id}`, ownerTeamId, status, rpmLimit: 60, tpmLimit: 100000 });

// `vi.mock` factories are hoisted above the module body, so the shared fixture
// state has to be hoisted with them.
const { state, prismaMock } = vi.hoisted(() => {
  const state: { keys: Key[] } = { keys: [] };
  const provider = {
    id: 'p1', baseUrl: 'https://api.example.com/v1', provider: 'openai',
    authHeader: 'Authorization', authPrefix: 'Bearer', tier: 'premium',
    preferredModel: 'gpt-x', isActive: true, createdAt: new Date(),
  };
  // findMany honours the `ownerTeamId` equality filter exactly as Postgres would
  // (null matches only null) — that equality *is* the isolation guarantee.
  const prismaMock = {
    nexusKey: {
      findMany: vi.fn(async ({ where }: { where: { providerId: string; ownerTeamId: string | null; status: { in: string[] } } }) =>
        state.keys.filter(k =>
          k.providerId === where.providerId &&
          where.status.in.includes(k.status) &&
          k.ownerTeamId === where.ownerTeamId)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const k = state.keys.find(x => x.id === where.id);
        return k ? { ...k, provider } : null;
      }),
      update: vi.fn(async () => ({})),
    },
    nexusProvider: {
      findMany: vi.fn(async ({ where }: { where: { tier: string } }) => (where.tier === 'premium' ? [provider] : [])),
    },
  };
  return { state, prismaMock };
});

vi.mock('../lib/prisma',     () => ({ prisma: prismaMock }));
vi.mock('../lib/encryption', () => ({ decrypt: (s: string) => `dec-${s}`, maskKey: (s: string) => s }));
vi.mock('../lib/admission',  () => ({ admitKey: vi.fn(async () => true) }));
vi.mock('../lib/breaker',    () => ({ acquire: vi.fn(async () => 'closed'), RATE_LIMIT_COOLDOWN_SECONDS: 60 }));
vi.mock('../lib/sticky',     () => ({ getStickyKeyId: vi.fn(async () => null) }));
vi.mock('./routing.service', () => ({ getCostWeight: vi.fn(async () => 0) }));
vi.mock('./model.service',   () => ({ getModelRegistry: vi.fn(async () => []) }));
vi.mock('./ssrf.service',    () => ({ getSsrfPolicy: vi.fn(async () => ({})) }));

import { discoverBestPool, SHARED_SCOPE } from './nexus.service';
import { getStickyKeyId } from '../lib/sticky';
import { admitKey }       from '../lib/admission';
import type { RoutingScope } from '../lib/scope';

const scopeFor = (teamId: string, fallback: boolean): RoutingScope =>
  ({ ownerTeamId: teamId, fallbackToShared: fallback, namespace: `team:${teamId}` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admitKey).mockResolvedValue(true);
  vi.mocked(getStickyKeyId).mockResolvedValue(null);
  state.keys = [key('shared-1', null), key('shared-2', null), key('a-1', 'team-a'), key('a-2', 'team-a')];
});

describe('discoverBestPool — BYOK scoping', () => {
  it('serves a shared-pool caller only from unowned keys', async () => {
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.keyId).toBe('shared-1');
    expect(route?.byok).toBe(false);
  });

  it('never hands a private key to a caller with no team, even when the pool is empty', async () => {
    state.keys = [key('a-1', 'team-a')]; // only a BYOK key exists
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route).toBeNull();
  });

  it("prefers the team's own keys over the shared pool", async () => {
    const route = await discoverBestPool(10, null, scopeFor('team-a', true));
    expect(route?.keyId).toBe('a-1');
    expect(route?.byok).toBe(true);
  });

  it('falls back to the shared pool once the team\'s own keys are exhausted', async () => {
    // Own keys admit nothing; pooled keys admit.
    vi.mocked(admitKey).mockImplementation(async (keyId: string) => !keyId.startsWith('a-'));
    const route = await discoverBestPool(10, null, scopeFor('team-a', true));
    expect(route?.keyId).toBe('shared-1');
    expect(route?.byok).toBe(false);
  });

  it('returns null instead of a pooled key when the team is hard-isolated', async () => {
    vi.mocked(admitKey).mockImplementation(async (keyId: string) => !keyId.startsWith('a-'));
    const route = await discoverBestPool(10, null, scopeFor('team-a', false));
    expect(route).toBeNull(); // → 503, never a credential the team did not bring
  });

  it('does not consult the shared pool at all for an isolated team', async () => {
    await discoverBestPool(10, null, scopeFor('team-a', false));
    const ownerFilters = prismaMock.nexusKey.findMany.mock.calls.map(c => c[0].where.ownerTeamId);
    expect(ownerFilters).not.toContain(null);
  });

  it('defaults to the shared pool when no scope is passed', async () => {
    const route = await discoverBestPool(10);
    expect(route?.byok).toBe(false);
  });
});

describe('discoverBestPool — sticky pins are re-authorized against scope', () => {
  it('refuses a pin to another team\'s private key and falls through', async () => {
    vi.mocked(getStickyKeyId).mockResolvedValue('a-1'); // pinned to team-a's key
    const route = await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(route?.keyId).toBe('shared-1'); // fell through to normal discovery
    expect(route?.sticky).toBe(false);
  });

  it('refuses a pin to a shared key for a hard-isolated team', async () => {
    vi.mocked(getStickyKeyId).mockResolvedValue('shared-1');
    const route = await discoverBestPool(10, 'sess', scopeFor('team-a', false));
    expect(route?.keyId).toBe('a-1');
    expect(route?.sticky).toBe(false);
  });

  it('honours a pin to the team\'s own key', async () => {
    vi.mocked(getStickyKeyId).mockResolvedValue('a-2');
    const route = await discoverBestPool(10, 'sess', scopeFor('team-a', true));
    expect(route?.keyId).toBe('a-2');
    expect(route?.sticky).toBe(true);
    expect(route?.byok).toBe(true);
  });

  it('allows a fall-back team to keep a pin on a shared key', async () => {
    vi.mocked(getStickyKeyId).mockResolvedValue('shared-2');
    const route = await discoverBestPool(10, 'sess', scopeFor('team-a', true));
    expect(route?.keyId).toBe('shared-2');
    expect(route?.sticky).toBe(true);
  });
});
