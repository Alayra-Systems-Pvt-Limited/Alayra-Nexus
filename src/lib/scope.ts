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

// ── Routing scope (Phase 5.5, BYOK) ───────────────────────────────────────────
// One request resolves to exactly one scope, and that scope answers two questions
// that must never disagree:
//
//   1. Which keys may serve this request?  (routing)
//   2. Which cached responses may serve it? (response cache namespace)
//
// Keeping both derived from the same value is what stops a cached response paid
// for by one team's private key from being replayed to another team.

/** The shared pool: every key with no owner. What every non-BYOK caller uses. */
export const SHARED_NAMESPACE = 'shared';

export interface RoutingScope {
  /** Owner filter for key selection. null = the shared pool. */
  ownerTeamId: string | null;
  /** May routing fall through to the shared pool once owned keys are exhausted? */
  fallbackToShared: boolean;
  /** Cache namespace. Folded into the response-cache key so scopes cannot collide. */
  namespace: string;
}

export interface ScopeTeam {
  id:            string;
  byokFallback?: boolean;
}

/**
 * Resolve the routing scope for a request.
 *
 * A team only enters BYOK mode when it actually owns at least one usable key.
 * A team with a `byokFallback: false` flag but no keys of its own is not
 * "isolated with nothing to route to" — it is simply a normal shared-pool team,
 * because the isolation flag only governs fall-back *from* its own keys.
 *
 * Requests with no team (the main Nexus API key) always resolve to the shared
 * pool, so a shared caller can never be handed a team's private credential.
 */
export function resolveScope(team: ScopeTeam | undefined | null, ownedKeyCount: number): RoutingScope {
  if (!team || ownedKeyCount <= 0) {
    return { ownerTeamId: null, fallbackToShared: true, namespace: SHARED_NAMESPACE };
  }
  return {
    ownerTeamId:      team.id,
    fallbackToShared: team.byokFallback !== false,
    // Namespaced per owning team. Two teams issuing an identical prompt each pay
    // their own provider once; neither ever replays the other's response.
    namespace:        `team:${team.id}`,
  };
}

/** True when this scope routes only to its own keys — a miss is a 503, not a fallback. */
export function isIsolated(scope: RoutingScope): boolean {
  return scope.ownerTeamId !== null && !scope.fallbackToShared;
}

/** True when this request is served from a team's own keys rather than the pool. */
export function isByok(scope: RoutingScope): boolean {
  return scope.ownerTeamId !== null;
}
