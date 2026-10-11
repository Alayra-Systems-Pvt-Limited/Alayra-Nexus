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

// ── Usage store port ──────────────────────────────────────────────────────────
// Where per-request usage rows go, and the one aggregate the request path reads back (a team's
// spend so far this budget period). Rows are written in batches by the usage pipeline, never
// inline on a request.

/** One request's usage, exactly as it is persisted. */
export interface UsageRow {
  id:             string;
  sessionId:      string;
  modelId:        string;
  modelName:      string;
  provider:       string;
  inputTokens:    number;
  outputTokens:   number;
  totalTokens:    number;
  // Per-modality billing (Phase 6.3b). Defaulted for token endpoints; an image request
  // records unit "image" and a quantity, so the batched insert stays a single shape.
  unit:           string;
  quantity:       number;
  estimatedUsd:   number;
  // Per-request outcome + latency (Phase 7.5). Every request emits an event now, not just the
  // successful ones, so success/error rates and latency can be charted from real data.
  outcome:        string;
  latencyMs:      number;
  // Response-cache accounting (Phase 7.5): `cached` marks a cache-served request (cost 0) and
  // `savedUsd` is what calling the provider would have cost.
  cached:         boolean;
  savedUsd:       number;
  nexusTeamKeyId: string | null;
  createdAt:      Date;
}

export interface UsageStore {
  /**
   * Persist a batch. Must be idempotent on `id`: the pipeline re-queues a failed batch, so a row
   * that was in fact written must not be written twice.
   */
  insertBatch(rows: UsageRow[]): Promise<void>;

  /** A team's estimated spend (USD) from `since` until now. */
  teamSpendSince(teamId: string, since: Date): Promise<number>;
}
