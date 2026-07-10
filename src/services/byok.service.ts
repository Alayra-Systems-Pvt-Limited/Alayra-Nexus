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

import { prisma }                     from '../lib/prisma';
import { resolveScope, type RoutingScope, type ScopeTeam } from '../lib/scope';

// ── BYOK scope resolution (Phase 5.5) ─────────────────────────────────────────
// A request's scope is resolved exactly once, at the top of the proxy, and then
// threaded through both the response-cache key and pool discovery. Doing it once
// is what guarantees those two never disagree — see lib/scope.ts.

/**
 * Count a team's own provider keys that could plausibly serve a request. Banned
 * keys are excluded (they will never be picked); cooling keys are counted, because
 * the circuit breaker may still admit one as a half-open probe.
 *
 * One indexed lookup on (ownerTeamId, status) — the index added in 0004_byok.
 */
export async function countOwnedKeys(teamId: string): Promise<number> {
  return prisma.nexusKey.count({
    where: { ownerTeamId: teamId, status: { in: ['active', 'cooling'] } },
  });
}

/**
 * Resolve the routing scope for this request. Requests without a team, and teams
 * that own no keys, resolve to the shared pool without touching the database.
 */
export async function resolveRequestScope(team: ScopeTeam | undefined | null): Promise<RoutingScope> {
  if (!team) return resolveScope(null, 0);
  const owned = await countOwnedKeys(team.id);
  return resolveScope(team, owned);
}
