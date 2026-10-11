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

// ── Provider store port ───────────────────────────────────────────────────────
// The provider pools (one row per configured upstream: base URL, auth style, tier) as the request
// path reads them. Pools are written only by an operator, so the port is read-only.

/** Exactly the columns routing reads from a pool. */
export interface ProviderRow {
  id: string;
  baseUrl: string | null;
  provider: string;
  authHeader: string;
  authPrefix: string | null;
  tier: string;
  preferredModel: string | null;
  extraHeaders: string | null;
}

/** A pool that names a preferred model, as the model registry merges it in. */
export interface PreferredModelPool {
  provider: string;
  preferredModel: string | null;
  tier: string;
  name: string;
}

export interface ProviderStore {
  /** Every active pool, oldest first. Callers filter in memory, so this order is selection order. */
  listActive(): Promise<ProviderRow[]>;

  /** Active pools that pin a preferred model. */
  listPreferredModelPools(): Promise<PreferredModelPool[]>;

  /** How many pools are active, for the pool gauge. */
  countActive(): Promise<number>;
}
