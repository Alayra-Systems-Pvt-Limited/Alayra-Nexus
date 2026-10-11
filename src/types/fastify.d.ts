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

import 'fastify';

// The auth middleware resolves a team key and attaches its id to the request so
// downstream handlers (proxy route, usage attribution) can read it. Declaring it
// here gives it a real type instead of the `as Record<string, unknown>` casts
// that were used before.
declare module 'fastify' {
  interface FastifyRequest {
    teamKeyId?: string;
    /** The admin caller's role, set by verifyAdminPassword: "owner" (full), "admin" (runs the
     *  gateway day to day, Phase 7.13a) or "viewer" (read-only). The guards read it to gate
     *  mutating routes. */
    adminRole?: 'owner' | 'admin' | 'viewer';
    /** Which account is behind the request (Phase 7.13a), or undefined for a token-minted or
     *  pre-accounts session — there is genuinely nobody to name in those cases. This is what lets
     *  the audit trail record a person rather than only a role. */
    adminUserId?: string;
    /** The account's display name, carried so audit writes need no second lookup. */
    adminUserName?: string;
    /** Present when the key belongs to a Team — carries what budget enforcement and BYOK scoping need. */
    team?: {
      id:           string;
      /** Display name, carried so a budget alert needs no team lookup (P0.5a). */
      name:         string;
      budgetUsd:    number | null;
      budgetPeriod: string;
      byokFallback: boolean;
      /** Preferred routing tier (Phase 8), or null for none. */
      assignedTier: string | null;
      /** What happens at the budget cap (Phase 7.10): "block" | "notify" | "downgrade". */
      overBudgetAction: string;
    };
  }
}
