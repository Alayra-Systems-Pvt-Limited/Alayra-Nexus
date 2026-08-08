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
// By default one premium provider `p1` and four keys on it: two shared, two owned
// by team-a. Tests that exercise tier fallback push extra providers onto
// `state.providers`. `encryptedKey` is irrelevant here — decrypt is stubbed.

type Key = { id: string; providerId: string; encryptedKey: string; ownerTeamId: string | null; status: string; rpmLimit: number; tpmLimit: number; maxUsers: number };
type Provider = { id: string; tier: string; baseUrl: string; provider: string; authHeader: string; authPrefix: string; preferredModel: string; isActive: boolean; createdAt: Date };

const key = (id: string, ownerTeamId: string | null, providerId = 'p1', status = 'active'): Key =>
  ({ id, providerId, encryptedKey: `enc-${id}`, ownerTeamId, status, rpmLimit: 60, tpmLimit: 100000, maxUsers: 1000 });

const provider = (id: string, tier: string): Provider => ({
  id, tier, baseUrl: 'https://api.example.com/v1', provider: 'openai',
  authHeader: 'Authorization', authPrefix: 'Bearer', preferredModel: `model-${id}`,
  isActive: true, createdAt: new Date(),
});

// `vi.mock` factories are hoisted above the module body, so the shared fixture
// state has to be hoisted with them.
const { state, prismaMock, admission } = vi.hoisted(() => {
  const state: { keys: Record<string, unknown>[]; providers: Record<string, unknown>[]; registry: Record<string, unknown>[] } =
    { keys: [], providers: [], registry: [] };

  // Selection is now a single KV call that walks the candidates itself (lib/selectKey.ts), so these
  // tests can no longer steer it by stubbing a per-key `admitKey`. This stands in for that walk:
  // the two predicates say which keys would be admitted, and `reserved` records the ones actually
  // written to — which is how "a key skipped for Max Users must not burn rate budget" stays
  // testable now that the guarantee lives inside the script.
  const admission: {
    admits: (keyId: string) => boolean;
    admitsUser: (keyId: string) => boolean;
    reserved: string[];
    calls: { candidates: { id: string; maxUsers: number }[]; reserveTokens: number; userId: string | null }[];
  } = { admits: () => true, admitsUser: () => true, reserved: [], calls: [] };
  // findMany honours the `ownerTeamId` equality filter exactly as Postgres would
  // (null matches only null) — that equality *is* the isolation guarantee.
  const prismaMock = {
    nexusKey: {
      findMany: vi.fn(async ({ where }: { where: { providerId: string; ownerTeamId: string | null; status: { in: string[] } } }) =>
        state.keys.filter(k =>
          k.providerId === where.providerId &&
          where.status.in.includes(k.status as string) &&
          k.ownerTeamId === where.ownerTeamId)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const k = state.keys.find(x => x.id === where.id);
        if (!k) return null;
        return { ...k, provider: state.providers.find(p => p.id === k.providerId) };
      }),
      update: vi.fn(async () => ({})),
      // `lastUsedAt` is written with updateMany, not update: Prisma compiles `update` to a
      // RETURNING of every column and nothing reads the row back.
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    nexusProvider: {
      // Handles every query shape the router uses, exactly as Postgres would: the legacy tier walk
      // (`where.tier`), a single-provider lookup (`where.provider` as a string), and the batched
      // model-first sweep (`where.provider` as `{ in: [...] }`).
      findMany: vi.fn(async ({ where }: { where: { tier?: string; provider?: string | { in: string[] }; isActive?: boolean } }) =>
        state.providers.filter((p) => {
          const tierOk = where.tier === undefined || p.tier === where.tier;
          const provOk = where.provider === undefined
            || (typeof where.provider === 'string' ? p.provider === where.provider : where.provider.in.includes(p.provider));
          return tierOk && provOk;
        })),
    },
  };
  return { state, prismaMock, admission };
});

vi.mock('../lib/prisma',     () => ({ dbEngine: 'postgres', prisma: prismaMock }));
vi.mock('../lib/encryption', () => ({ decrypt: (s: string) => `dec-${s}`, maskKey: (s: string) => s }));
// The real selectAndReserve talks to the KV; this suite is about SELECTION, not admission mechanics.
// The walk itself — breaker gate, Max Users, RPM/TPM, and the order the side effects happen in — is
// covered against BOTH the Lua and its twin in lib/kv/parity.test.ts, which is where it belongs.
vi.mock('../lib/selectKey', () => ({
  selectAndReserve: vi.fn(async (
    candidates: { id: string; maxUsers: number }[],
    reserveTokens: number,
    userId: string | null,
  ) => {
    admission.calls.push({ candidates, reserveTokens, userId });
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i]!.id;
      // A request with no user identity cannot be capped, matching the script's "no signal never
      // blocks" rule — so the user predicate only applies when there is a user.
      if (userId !== null && !admission.admitsUser(id)) continue;
      if (!admission.admits(id)) continue;
      admission.reserved.push(id);
      return { index: i, gate: 'closed' as const };
    }
    return null;
  }),
}));
vi.mock('../lib/breaker',    () => ({ acquire: vi.fn(async () => 'closed'), RATE_LIMIT_COOLDOWN_SECONDS: 60 }));
vi.mock('../lib/sticky',     () => ({ getStickyKeyId: vi.fn(async () => null) }));
vi.mock('./routing.service', () => ({ getCostWeight: vi.fn(async () => 0) }));
vi.mock('./model.service',   () => ({
  getModelRegistry:    vi.fn(async () => state.registry),
  activeProviderSlugs: vi.fn(async () => new Set(state.providers.map(p => p.provider as string))),
}));
// Routing reads its pools through the provider cache rather than querying per request. Mocked here
// for the same reason model.service is: this suite is about SELECTION, and a real cache would carry
// one test's providers into the next (which is exactly what it did, and how these four tests caught
// the change). providerCache.service.test.ts covers the caching itself.
vi.mock('./providerCache.service', () => ({
  // Filtered on isActive, because the real cache holds ONLY active pools — that is the property
  // sticky routing now relies on to notice a deactivated pool, having previously read
  // `key.provider.isActive` off an include. A mock that returned inactive rows too would make the
  // fall-through untestable and quietly greener than the code deserves.
  getActiveProviders:      vi.fn(async () => state.providers.filter((p) => p.isActive !== false)),
  invalidateProviderCache: vi.fn(async () => {}),
}));
vi.mock('./ssrf.service',    () => ({ getSsrfPolicy: vi.fn(async () => ({})) }));
vi.mock('./notifications.service', () => ({ notify: vi.fn(async () => {}) }));

import { discoverBestPool, SHARED_SCOPE, reportTierExhausted, banKey } from './nexus.service';
import { notify } from './notifications.service';
import { getStickyKeyId } from '../lib/sticky';
import { forgetLastUsed } from '../lib/lastUsed';
import { forgetKeyRow } from '../lib/keyRowCache';
import type { RoutingScope } from '../lib/scope';

const scopeFor = (teamId: string, fallback: boolean): RoutingScope =>
  ({ ownerTeamId: teamId, fallbackToShared: fallback, namespace: `team:${teamId}` });

beforeEach(() => {
  vi.clearAllMocks();
  // The debounce keeps module-level state, so without this a key written in one test would stay
  // suppressed in the next and the suite would depend on execution order.
  forgetLastUsed();
  forgetKeyRow();
  admission.admits = () => true;
  admission.admitsUser = () => true;
  admission.reserved = [];
  admission.calls = [];
  vi.mocked(getStickyKeyId).mockResolvedValue(null);
  state.providers = [provider('p1', 'premium')];
  state.keys = [key('shared-1', null), key('shared-2', null), key('a-1', 'team-a'), key('a-2', 'team-a')];
  // Default: empty registry, so the existing BYOK/sticky/downgrade suites exercise the
  // legacy pool-tier fallback (pools carry preferredModel). Model-first tests below
  // populate state.registry explicitly.
  state.registry = [];
});

describe('reportTierExhausted (Phase 6.4b)', () => {
  // 7.11: this used to short-circuit on `notificationsArmed`, which read the *email* config — so
  // with delivery off (the default) the gateway could run out of capacity and the dashboard would
  // never hear about it. The alert is now always raised; notify() decides what leaves the building.
  it('always raises the alert, leaving delivery for notify() to gate', async () => {
    await reportTierExhausted('chat', false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tierExhausted', dedupeKey: 'tierExhausted:chat:shared',
    }));
  });

  it('tags the alert isolated vs shared, and coalesces on that distinction', async () => {
    await reportTierExhausted('embedding', true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tierExhausted', dedupeKey: 'tierExhausted:embedding:isolated',
    }));
  });
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
    admission.admits = (keyId) => !keyId.startsWith('a-');
    const route = await discoverBestPool(10, null, scopeFor('team-a', true));
    expect(route?.keyId).toBe('shared-1');
    expect(route?.byok).toBe(false);
  });

  it('returns null instead of a pooled key when the team is hard-isolated', async () => {
    admission.admits = (keyId) => !keyId.startsWith('a-');
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

describe('discoverBestPool — Max Users cap (P7.4d)', () => {
  it('rotates a new user past a key that is full, to the next key', async () => {
    // shared-1 is at its Max Users cap for this new user; shared-2 has room.
    admission.admitsUser = (keyId) => keyId !== 'shared-1';
    const route = await discoverBestPool(10, null, SHARED_SCOPE, 'chat', 'user-new');
    expect(route?.keyId).toBe('shared-2');
    // A key that is full for a new user must not burn rate budget being skipped. The script now
    // reads every test before it writes anything, so nothing was reserved on shared-1 at all.
    expect(admission.reserved).not.toContain('shared-1');
  });

  it('passes the request through when no user id is supplied (cap cannot be enforced)', async () => {
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.keyId).toBe('shared-1');
    // Offered with a null user id and the key's cap, and the script decides not to block on it.
    expect(admission.calls[0]?.userId).toBeNull();
    expect(admission.calls[0]?.candidates[0]).toMatchObject({ id: 'shared-1', maxUsers: 1000 });
  });

  it('returns null when every key is full for a new user', async () => {
    admission.admitsUser = () => false;
    const route = await discoverBestPool(10, null, SHARED_SCOPE, 'chat', 'user-new');
    expect(route).toBeNull();
  });
});

describe('discoverBestPool — wasDowngrade', () => {
  // A downgrade means the deployment could normally have done better for this
  // request. Being served by a lower tier index is not, on its own, evidence of that.
  it('is false when the top tier serves the request', async () => {
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.tier).toBe('premium');
    expect(route?.wasDowngrade).toBe(false);
  });

  it('is true when a staffed higher tier is exhausted and a lower tier answers', async () => {
    state.providers = [provider('p1', 'premium'), provider('p2', 'standard')];
    state.keys = [key('prem-1', null, 'p1'), key('std-1', null, 'p2')];
    admission.admits = (keyId) => !keyId.startsWith('prem-');

    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.keyId).toBe('std-1');
    expect(route?.tier).toBe('standard');
    expect(route?.wasDowngrade).toBe(true);
  });

  it('is false when no higher tier is configured at all', async () => {
    // `standard` is this operator's top tier. Nothing was given up, so reporting a
    // downgrade would send a false alarm on every single request.
    state.providers = [provider('p2', 'standard')];
    state.keys = [key('std-1', null, 'p2')];

    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.tier).toBe('standard');
    expect(route?.wasDowngrade).toBe(false);
  });

  it('is true when a higher tier is configured but holds no usable key', async () => {
    // An active premium pool with no keys is a misconfiguration, and from the
    // caller's side it is indistinguishable from an exhausted one: premium capacity
    // was advertised and could not serve. Flagging it is the point of the header.
    state.providers = [provider('p1', 'premium'), provider('p2', 'standard')];
    state.keys = [key('std-1', null, 'p2')];

    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.tier).toBe('standard');
    expect(route?.wasDowngrade).toBe(true);
  });

  it('is true across a two-tier gap', async () => {
    state.providers = [provider('p1', 'premium'), provider('p2', 'standard'), provider('p3', 'fast')];
    state.keys = [key('prem-1', null, 'p1'), key('std-1', null, 'p2'), key('fast-1', null, 'p3')];
    admission.admits = (keyId) => keyId.startsWith('fast-');

    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.tier).toBe('fast');
    expect(route?.wasDowngrade).toBe(true);
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

  it('writes lastUsedAt once for a burst on the same key, not once per request', async () => {
    // lastUsed.test.ts proves the debounce decides correctly in isolation; this proves ROUTING
    // asks it. The two are different failures — a helper nobody calls passes its own tests.
    vi.mocked(getStickyKeyId).mockResolvedValue('shared-1');
    for (let i = 0; i < 5; i++) await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(prismaMock.nexusKey.updateMany).toHaveBeenCalledTimes(1);
  });

  it('reads the pinned key from the database once for a burst, not once per request', async () => {
    vi.mocked(getStickyKeyId).mockResolvedValue('shared-1');
    for (let i = 0; i < 5; i++) await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(prismaMock.nexusKey.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads the key immediately after it is banned, without waiting out the TTL', async () => {
    // The property the whole cache stands on. A banned key's credential may already be revoked
    // upstream, so "it will refresh in a second" is not good enough -- banKey has to drop it.
    vi.mocked(getStickyKeyId).mockResolvedValue('shared-1');
    await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(prismaMock.nexusKey.findUnique).toHaveBeenCalledTimes(1);

    await banKey('shared-1');
    await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(prismaMock.nexusKey.findUnique).toHaveBeenCalledTimes(2);
  });

  it('refuses a pin to a key whose pool was deactivated, and falls through', async () => {
    // A pin outlives the request that set it, so an operator can switch a pool off underneath one.
    // This used to be caught by reading `isActive` from the joined provider row; the join is gone,
    // and the equivalent signal is now the pool's ABSENCE from the active-provider cache. Same
    // outcome, different mechanism — which is exactly the kind of swap that needs its own test.
    state.providers.push({ ...provider('p2', 'premium'), isActive: false });
    state.keys.push(key('p2-1', null, 'p2'));

    vi.mocked(getStickyKeyId).mockResolvedValue('p2-1');
    const route = await discoverBestPool(10, 'sess', SHARED_SCOPE);

    expect(route?.keyId).toBe('shared-1');   // fell through to normal discovery
    expect(route?.sticky).toBe(false);
  });
});

// ── Phase 6.1: model-first selection ──────────────────────────────────────────
const rmodel = (over: Record<string, unknown>) => ({
  id: over.id, modelString: over.modelString ?? over.id, provider: over.provider ?? 'openai',
  tier: over.tier ?? 'standard', priority: over.priority ?? 1, status: over.status ?? 'active',
  capabilities: over.capabilities ?? ['chat'],
});

describe('discoverBestPool — model-first (registry drives the model)', () => {
  it('serves the registry model, not the pool preferredModel, and stamps modelId', async () => {
    state.providers = [provider('p1', 'premium')]; // pool.preferredModel = "model-p1"
    state.keys = [key('k', null, 'p1')];
    state.registry = [rmodel({ id: 'sonnet', modelString: 'claude-sonnet', provider: 'openai', tier: 'premium' })];

    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.keyId).toBe('k');
    expect(route?.modelString).toBe('claude-sonnet'); // from the registry, not "model-p1"
    expect(route?.modelId).toBe('sonnet');
  });

  it('serves two models from one provider by tier — premium before fast', async () => {
    state.providers = [provider('p1', 'standard')]; // pool tier is now irrelevant to selection
    state.keys = [key('k', null, 'p1')];
    state.registry = [
      rmodel({ id: 'haiku',  modelString: 'claude-haiku',  tier: 'fast',    priority: 1 }),
      rmodel({ id: 'sonnet', modelString: 'claude-sonnet', tier: 'premium', priority: 1 }),
    ];
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.modelId).toBe('sonnet');
    expect(route?.tier).toBe('premium');
  });

  it('skips a registry model whose provider has no pool', async () => {
    state.providers = [provider('p1', 'standard')]; // only openai
    state.keys = [key('k', null, 'p1')];
    state.registry = [
      rmodel({ id: 'no-pool', provider: 'anthropic', tier: 'premium' }),
      rmodel({ id: 'has-pool', provider: 'openai',   tier: 'standard' }),
    ];
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.modelId).toBe('has-pool');
  });

  it('skips a paused model', async () => {
    state.providers = [provider('p1', 'standard')];
    state.keys = [key('k', null, 'p1')];
    state.registry = [
      rmodel({ id: 'paused', tier: 'premium', status: 'paused' }),
      rmodel({ id: 'active', tier: 'standard', status: 'active' }),
    ];
    const route = await discoverBestPool(10, null, SHARED_SCOPE);
    expect(route?.modelId).toBe('active');
  });

  it('returns null when no model has the requested capability', async () => {
    state.providers = [provider('p1', 'standard')];
    state.keys = [key('k', null, 'p1')];
    state.registry = [rmodel({ id: 'chat-only', capabilities: ['chat'] })];
    // embedding has no legacy fallback, so an unserved capability is a clean miss
    const route = await discoverBestPool(10, null, SHARED_SCOPE, 'embedding');
    expect(route).toBeNull();
  });

  it('routes an embedding request to the embedding-capable model', async () => {
    state.providers = [provider('p1', 'standard')];
    state.keys = [key('k', null, 'p1')];
    state.registry = [
      rmodel({ id: 'chat',  capabilities: ['chat'] }),
      rmodel({ id: 'embed', modelString: 'text-embed-3', capabilities: ['embedding'] }),
    ];
    const route = await discoverBestPool(10, null, SHARED_SCOPE, 'embedding');
    expect(route?.modelId).toBe('embed');
    expect(route?.modelString).toBe('text-embed-3');
  });

  it('still enforces BYOK scope in model-first mode', async () => {
    state.providers = [provider('p1', 'standard')];
    state.keys = [key('shared', null, 'p1'), key('owned', 'team-a', 'p1')];
    state.registry = [rmodel({ id: 'm', provider: 'openai' })];
    const route = await discoverBestPool(10, null, scopeFor('team-a', true));
    expect(route?.keyId).toBe('owned');
    expect(route?.byok).toBe(true);
    expect(route?.modelId).toBe('m');
  });

  it('honours a sticky pin in model-first mode, serving the registry model', async () => {
    state.providers = [provider('p1', 'standard')];
    state.keys = [key('k1', null, 'p1'), key('k2', null, 'p1')];
    state.registry = [rmodel({ id: 'm', modelString: 'the-model', provider: 'openai' })];
    vi.mocked(getStickyKeyId).mockResolvedValue('k2');
    const route = await discoverBestPool(10, 'sess', SHARED_SCOPE);
    expect(route?.keyId).toBe('k2');
    expect(route?.sticky).toBe(true);
    expect(route?.modelString).toBe('the-model');
    expect(route?.modelId).toBe('m');
  });
});
