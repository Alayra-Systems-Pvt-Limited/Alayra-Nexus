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

// ── Key store port ────────────────────────────────────────────────────────────
// Everything the request path needs to read or write about provider API keys, and nothing more.
// The open-source gateway answers it from its own database; the hosted gateway answers it from a
// tenant's encrypted vault. Each method maps to exactly one query the router used to issue inline,
// so an adapter is a translation, never a place for routing logic. The one read off the request
// path is `findForCheck`, for the operator's key test, so that it too goes through the vault.

import type { ProviderCheckRow } from './providerStore';

/** Exactly the columns routing reads from a key. `encryptedKey` is still ciphertext here. */
export interface KeyRow {
  id: string;
  providerId: string;
  status: string;
  ownerTeamId: string | null;
  maxUsers: number;
  rpmLimit: number;
  tpmLimit: number;
  encryptedKey: string;
}

/** Display-only facts for an operator alert about one key. */
export interface KeyAlertFacts {
  maskedKey: string;
  providerSlug: string;
}

/** One key's state as the metrics gauges count it. */
export interface KeyStateRow {
  status: string;
  coolingUntil: Date | null;
}

/** A key and its pool, for the operator's "test this key" action. */
export interface KeyCheck {
  /** Still ciphertext. */
  encryptedKey: string;
  provider: ProviderCheckRow;
}

export interface KeyStore {
  /**
   * Keys a pool may route to, least-recently-used first: a key never used comes before every used
   * one, and keys with the same `lastUsedAt` (or none) are ordered by id. Active and cooling keys are both
   * returned: the circuit breaker, not this column, decides whether a cooling key may probe.
   * `ownerTeamId` is an equality filter: null is the shared pool, an id is that team's keys only.
   */
  listRoutable(providerId: string, ownerTeamId: string | null): Promise<KeyRow[]>;

  /** One key by id with the routing projection, or null when it no longer exists. */
  findRoutable(keyId: string): Promise<KeyRow | null>;

  /** Stamp the key as just used. Debounced by the caller; never read back. */
  touchLastUsed(keyId: string, at: Date): Promise<void>;

  /**
   * Mark a key banned for good (auth failure or operator action). After an auth-failure ban the core
   * reads the key back with `findRoutable`: if it is still active or cooling (a host that decides key
   * disabling itself may keep it), the operator alert is `keyAuthRefused`, not `keyBanned`.
   */
  markBanned(keyId: string): Promise<void>;

  /** Mark a key cooling until `until` (display column; the breaker gate lives in the KV). */
  markCooling(keyId: string, until: Date): Promise<void>;

  /** A probe succeeded: return a key that is still cooling to active. No-op otherwise. */
  markRecovered(keyId: string): Promise<void>;

  /** The soonest cooling deadline across all keys, or null when nothing is cooling. */
  nextCoolingUntil(): Promise<Date | null>;

  /** Facts an operator alert names the key by, or null when the key is gone. */
  alertFacts(keyId: string): Promise<KeyAlertFacts | null>;

  /** How many usable (active or cooling) keys a team owns. */
  countOwnedUsable(teamId: string): Promise<number>;

  /** Provider slugs of the active pools a team owns usable keys in. */
  ownedProviderSlugs(teamId: string): Promise<Set<string>>;

  /** How many usable keys exist in total, any owner. */
  countUsable(): Promise<number>;

  /** Status of every key, for the pool gauges. */
  listStates(): Promise<KeyStateRow[]>;

  /** One key with its pool, for the operator's key test, or null when it no longer exists. */
  findForCheck(keyId: string): Promise<KeyCheck | null>;
}
