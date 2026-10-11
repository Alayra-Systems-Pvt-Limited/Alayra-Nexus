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

// ── Caller context ────────────────────────────────────────────────────────────
// Who is calling, as the core sees it. The core never authenticates: the host checks the API key
// (a team key in the open-source gateway, a tenant key in the hosted one) and hands over this
// already-resolved context. Everything the router decides per caller (budget gate, BYOK scope,
// preferred tier) is derived from these fields and nothing else.

/** The team (or hosted tenant) a request is billed and scoped to. */
export interface TeamContext {
  id:           string;
  budgetUsd:    number | null;
  budgetPeriod: string;
  byokFallback?: boolean;
  /** Preferred routing tier (Phase 8). null = no preference; routing uses the normal tier order. */
  assignedTier?: string | null;
  /** What happens at the budget cap (Phase 7.10): "block" | "notify" | "downgrade". Defaults to block. */
  overBudgetAction?: string;
}

/** A resolved caller. Absent team = the gateway's own master key, which routes the shared pool. */
export interface CallerContext {
  /** The API key the caller authenticated with, for usage attribution. */
  teamKeyId?: string;
  team?:      TeamContext;
}
