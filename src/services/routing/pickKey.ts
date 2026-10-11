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
import type { ProviderRow } from '../../core/ports';
import { selectAndReserve } from '../../lib/selectKey';
import { shouldWriteLastUsed } from '../../lib/lastUsed';
import { getKeyRow, setKeyRow, getKeyList, setKeyList } from '../../lib/keyRowCache';
import type { RoutingScope } from '../../lib/scope';
import { getActiveProviders } from '../providerCache.service';
import { buildRoute, type NexusRoute, type RouteModel } from './route';

// ── Picking one key: from a pool, or from a session's sticky pin ──────────────

/** Try the keys of one pool, least-recently-used first; null when none has headroom. */
export async function tryPickKey(
  providerRow: ProviderRow,
  reserveTokens: number,
  ownerTeamId: string | null,
  model: RouteModel,
  userId: string | null,
): Promise<Omit<NexusRoute, 'wasDowngrade' | 'sticky'> | null> {
  if (!model.modelString) return null;

  const now  = new Date();
  // Cooling keys are included so the circuit breaker can decide (open vs. probe)
  // — the live gate is the breaker state in the KV, not the DB column. Banned keys stay out.
  //
  // `ownerTeamId` scopes the candidate set: null selects the shared pool (keys with
  // no owner), a team id selects only that team's private keys. It is an equality
  // filter, never a superset — a shared-pool caller can never see a BYOK key.
  //
  // Read through a one-second cache. This query ran once per POOL TRIED, so a request that walked a
  // deep sweep paid one database round trip per exhausted pool on top of the Redis work — measured
  // by `bench:routing` as exactly +1.0 query per pool walked, arriving when capacity is tight.
  //
  // The projection is narrowed at the same time: this read every column, including the label, the
  // masked key and both timestamps, where routing uses eight fields. See lib/keyRowCache.ts for what
  // the second costs, and why caching the LRU ordering is safe when `lastUsedAt` is already written
  // at most once per five seconds.
  let keys = getKeyList(providerRow.id, ownerTeamId);
  if (keys === undefined) {
    keys = await (await coreStores()).keys.listRoutable(providerRow.id, ownerTeamId);
    setKeyList(providerRow.id, ownerTeamId, keys);
  }

  // The breaker gate, the Max Users cap and the atomic RPM/TPM reservation, for EVERY candidate, in
  // one round trip. This was a loop that asked each of those separately per key, so a key rejected
  // at the last test had already cost two hops — paid again for every key turned down before one
  // worked. The selection rules are unchanged and still "rotate first, fail last": null here means
  // nothing in this pool had headroom, and the caller moves on to the next.
  //
  // See lib/selectKey.ts, including the two side effects the old order left on keys it went on to
  // reject — an abandoned probe slot and a Max Users entry for a key that never served the user.
  const chosen = await selectAndReserve(keys, reserveTokens, userId);
  if (!chosen) return null;

  const key = keys[chosen.index];
  if (!key) return null;

  // Written at most once per window, not once per request. `updateMany` rather than `update`
  // because Prisma's `update` compiles to a RETURNING of every column, and nothing here reads
  // the row back. See lib/lastUsed.ts for what the window costs.
  if (shouldWriteLastUsed(key.id, now.getTime())) {
    await (await coreStores()).keys.touchLastUsed(key.id, now);
  }
  return buildRoute(key, providerRow, chosen.gate, model);
}

/**
 * Try to route to a session's last-successful key (cache-aware sticky routing).
 * Returns null when there is no sticky key, or when it is banned, breaker-open, out of
 * headroom, scope-ineligible, or its provider serves no model for this request's
 * capability — the caller then falls back to normal discovery.
 *
 * `pickModel` maps the pinned key's provider to the model it should serve. This is how
 * sticky reuses the *key* (for the provider's prompt cache) while still honouring the
 * registry as the source of the model string — and, on the legacy path, the pool's own
 * preferred model.
 */
export async function tryStickyKey(
  keyId: string,
  reserveTokens: number,
  scope: RoutingScope,
  pickModel: (provider: ProviderRow) => RouteModel | null,
  userId: string | null,
): Promise<NexusRoute | null> {
  // Read through a one-second cache. `findUnique` returned every column of the row -- label,
  // maskedKey, both timestamps -- where routing reads eight fields, so the projection is
  // narrowed here too: less to decode on a miss, less to hold on a hit. See lib/keyRowCache.ts
  // for why one second is both enough and the worst case.
  let key = getKeyRow(keyId);
  if (key === undefined) {
    key = await (await coreStores()).keys.findRoutable(keyId);
    setKeyRow(keyId, key);
  }
  if (!key || key.status === 'banned') return null;

  // The pool comes from the provider cache rather than an `include`. Prisma issues an include as a
  // SECOND query — and one that reads every column, where routing needs eight — so on the sticky
  // path, which is the common path once a conversation is going, it was a per-request round trip
  // for a row that changes when an operator edits a pool.
  //
  // The cache holds only ACTIVE pools, which is what makes this a faithful swap rather than a
  // near-enough one: a pool that is missing here is inactive or deleted, and both used to fail the
  // `!key.provider.isActive` check. A linear scan is deliberate — deployments have a handful of
  // pools, and a Map would be rebuilt on every call anyway since the cache decodes fresh JSON.
  const provider = (await getActiveProviders()).find((p) => p.id === key.providerId);
  if (!provider) return null;

  const model = pickModel(provider);
  if (!model) return null;

  // A sticky pin is a Redis session→key mapping that outlives any single request,
  // so it must be re-authorized against this caller's scope. Without this check a
  // session pinned while on the shared pool could resurface that key for an
  // isolated BYOK team (and vice versa). An unusable pin just falls through to
  // normal discovery.
  const eligible = key.ownerTeamId === scope.ownerTeamId
    || (key.ownerTeamId === null && scope.fallbackToShared);
  if (!eligible) return null;

  // The same three tests the sweep applies — breaker gate, Max Users cap, atomic RPM/TPM
  // reservation — against a candidate list of exactly one. They were three separate round trips
  // here, on what is the COMMON path once a conversation is going: a pinned request paid three hops
  // to be told yes. A pinned key still honours its Max Users cap, so a new end-user over it falls
  // through to normal discovery rather than riding the pin.
  const chosen = await selectAndReserve([key], reserveTokens, userId);
  if (!chosen) return null;

  const now = Date.now();
  if (shouldWriteLastUsed(key.id, now)) {
    await (await coreStores()).keys.touchLastUsed(key.id, new Date(now));
  }
  return { ...buildRoute(key, provider, chosen.gate, model), wasDowngrade: false, sticky: true };
}
