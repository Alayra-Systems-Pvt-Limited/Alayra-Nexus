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

// ── Routing: the public face ──────────────────────────────────────────────────
// The router lives in services/routing/, one concern per module. This file stays the one import
// every caller uses, and it must: the proxy stages and the tests reach routing through this path,
// and `vi.mock('./nexus.service')` intercepts a call only when it comes through here.

// The route a chosen key produces, and the scope and tier vocabulary around it.
export { SHARED_SCOPE, TIER_ORDER, type Tier, type NexusRoute } from './routing/route';

// Choosing a key: model-first discovery with sticky routing, BYOK scope, and the legacy walk.
export { discoverBestPool } from './routing/discovery';

// Key health: cooldowns, bans, and the circuit breaker's outcome reporters.
export {
  getNextCooldownSeconds, banKey, coolKey,
  reportSuccess, reportRateLimit, reportServerFailure, reportAuthFailure, reportTierExhausted,
} from './routing/keyHealth';

// Operator checks behind the dashboard's test / validate / fetch-models buttons.
export { testKey, validateProviderCredentials, validateModel, fetchProviderModels } from './routing/providerAdmin';

// Kept exported from here because callers (and their tests) import them from this module.
export { maskKey } from '../lib/encryption';

// Re-exported rather than re-implemented: this used to be a switch that knew five providers while
// the dashboard's own defaults map knew six and the key-prefix map knew a seventh set. See
// src/data/providers.ts for why they are now one table.
export { providerDefaultUrl } from '../data/providers';
