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

// ── Prisma usage store ────────────────────────────────────────────────────────
// Usage rows land in the TokenUsage table in chunks; the team-spend aggregate seeds the budget
// counter when Redis has no running total for the period.

import { prisma } from '../../lib/prisma';
import { createManyIgnoringDuplicates } from '../../lib/bulkInsert';
import type { UsageStore } from '../../core/ports';

// Postgres caps parameters per statement (~65535); chunk so a large drain can't blow past it.
// SQLite's limit is lower still (999 variables by default), and TokenUsage is a wide row, so the
// same chunk size serves both. The insert is idempotent so a re-queued retry cannot duplicate a
// row — ids are UUIDs, so a collision is always a row we already wrote. See lib/bulkInsert.ts:
// SQLite has no skipDuplicates, and reaching for it there is a validation error, not a no-op.
export const INSERT_CHUNK = 500;

export const prismaUsageStore: UsageStore = {
  insertBatch: async (rows) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await createManyIgnoringDuplicates(prisma.tokenUsage, rows.slice(i, i + INSERT_CHUNK));
    }
  },

  teamSpendSince: async (teamId, since) => {
    const agg = await prisma.tokenUsage.aggregate({
      _sum:  { estimatedUsd: true },
      where: { createdAt: { gte: since }, teamKey: { teamId } },
    });
    return agg._sum.estimatedUsd ?? 0;
  },
};
