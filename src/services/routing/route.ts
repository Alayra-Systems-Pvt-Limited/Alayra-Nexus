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

import { decrypt, maskKey } from '../../lib/encryption';
import type * as breaker from '../../lib/breaker';
import { providerDefaultUrl } from '../../data/providers';
import { SHARED_NAMESPACE, type RoutingScope } from '../../lib/scope';
// Provider fields the router needs to build a route from a picked key: the ProviderStore row.
import type { ProviderRow } from '../../core/ports';

// ── The route: what the proxy is handed once a key is chosen ──────────────────
/** The scope every caller gets when no team owns keys — the shared pool. */
export const SHARED_SCOPE: RoutingScope = {
  ownerTeamId: null, fallbackToShared: true, namespace: SHARED_NAMESPACE,
};

export type Tier = 'premium' | 'standard' | 'fast';

export const TIER_ORDER: Tier[] = ['premium', 'standard', 'fast'];

export interface NexusRoute {
  keyId:        string;
  decryptedKey: string;
  /**
   * The same masked form the dashboard shows for this key (`maskKey`, so the two always agree).
   *
   * Carried on the route so that everything downstream which legitimately needs to say WHICH key
   * served a request — a trace, a diagnostic, a log line — has a safe answer sitting right beside
   * the credential, rather than a reason to reach for `decryptedKey`. See #117: the plaintext above
   * is necessary and is guarded only by nobody having copied it yet.
   */
  keyMask:      string;
  baseUrl:      string;
  modelString:  string;
  // The registry model id this route serves, when selection came from the registry
  // (Phase 6.1). null on the legacy fallback path. Used so usage/cost is attributed to
  // the real model rather than string-matched against a pool's preferred model.
  modelId:      string | null;
  providerSlug: string;
  tier:         Tier;
  authHeader:   string;
  authPrefix:   string | null;
  // The provider's optional extra request headers (JSON object string), applied by the proxy
  // path under the system headers. null when the provider has none.
  extraHeaders: string | null;
  wasDowngrade: boolean;
  // True when this request is the single half-open probe for a recovering key —
  // its outcome must be reported so the breaker closes or re-escalates.
  isProbe:      boolean;
  // True when the key was chosen by cache-aware sticky routing rather than LRU.
  sticky:       boolean;
  // True when the key is privately owned by the calling team (BYOK) rather than
  // drawn from the shared pool.
  byok:         boolean;
  /** Key state and configured limits at the instant the route was selected. */
  keyStatus:    string;
  rpmLimit:     number;
  tpmLimit:     number;
}


// The model a route will serve. On the model-first path it comes from the registry; on
// the legacy fallback it is synthesised from the pool's own tier + preferredModel.
export type RouteModel = { modelString: string; modelId: string | null; tier: string };

export function buildRoute(
  key: { id: string; encryptedKey: string; ownerTeamId: string | null; status: string; rpmLimit: number; tpmLimit: number },
  provider: ProviderRow,
  gate: breaker.BreakerGate,
  model: RouteModel,
): Omit<NexusRoute, 'wasDowngrade' | 'sticky'> {
  // Decrypted once and masked from that, rather than read from the `maskedKey` column: the mask
  // then describes the key this route will actually authenticate with, and cannot drift from it.
  const decryptedKey = decrypt(key.encryptedKey);
  return {
    keyId:        key.id,
    decryptedKey,
    keyMask:      maskKey(decryptedKey),
    baseUrl:      provider.baseUrl ?? providerDefaultUrl(provider.provider),
    modelString:  model.modelString,
    modelId:      model.modelId,
    providerSlug: provider.provider,
    tier:         (model.tier as Tier),
    authHeader:   provider.authHeader,
    authPrefix:   provider.authPrefix,
    extraHeaders: provider.extraHeaders,
    isProbe:      gate === 'probe',
    byok:         key.ownerTeamId !== null,
    keyStatus:    key.status,
    rpmLimit:     key.rpmLimit,
    tpmLimit:     key.tpmLimit,
  };
}
