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

// ── The Prisma usage store writes the same columns it always did (P1.1) ───────────────────────
// UsageRow gained `teamId`; TokenUsage has no such column, so the adapter must leave it out — a
// stray field is a Prisma validation error, which would turn every usage flush into a retry loop.
// The conformance suite proves this against real PostgreSQL and SQLite in CI; this pins it without.

import { describe, it, expect, vi } from 'vitest';

const { createMany } = vi.hoisted(() => ({
  createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
}));
vi.mock('../../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { tokenUsage: { createMany } } }));

import { prismaUsageStore } from './usageStore';
import type { UsageRow } from '../../core/ports';

const row = (id: string, teamId: string | null): UsageRow => ({
  id, sessionId: 's', modelId: 'gpt-x', modelName: 'gpt-x', provider: 'openai', inputTokens: 1, outputTokens: 2,
  totalTokens: 3, unit: 'token', quantity: 0, estimatedUsd: 0.01, outcome: 'success', latencyMs: 5, cached: false,
  savedUsd: 0, nexusTeamKeyId: teamId ? 'tk-1' : null, teamId, createdAt: new Date('2026-03-01T00:00:00Z'),
});

describe('prismaUsageStore.insertBatch', () => {
  it('writes every column except teamId, and nothing else changes', async () => {
    const rows = [row('u-1', 'team-1'), row('u-2', null)];
    await prismaUsageStore.insertBatch(rows);

    const written = createMany.mock.calls[0]![0].data as Record<string, unknown>[];
    expect(written).toHaveLength(2);
    for (const [i, w] of written.entries()) {
      expect(w).not.toHaveProperty('teamId');
      const { teamId: _teamId, ...expected } = rows[i]!;
      expect(w).toEqual(expected);
    }
    // The caller's rows are not mutated: the pipeline may re-queue them after a failed write.
    expect(rows[0]!.teamId).toBe('team-1');
  });

  it('writes the token kinds a row carries (they are TokenUsage columns), and adds none to a row without them', async () => {
    const kinds = { cachedInputTokens: 7, cacheWriteTokens: 2, cacheWrite5mTokens: 1, cacheWrite1hTokens: 1, cacheMissTokens: 3, reasoningTokens: 0 };
    await prismaUsageStore.insertBatch([{ ...row('u-3', null), ...kinds }, row('u-4', null)]);

    const written = createMany.mock.calls.at(-1)![0].data as Record<string, unknown>[];
    expect(written[0]).toMatchObject(kinds);
    for (const k of Object.keys(kinds)) expect(written[1]).not.toHaveProperty(k);
  });
});
