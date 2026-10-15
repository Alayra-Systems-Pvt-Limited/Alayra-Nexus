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

// The Prisma usage store persists the token kinds (1.8.0) on BOTH engines, and a row without them
// reads back exactly as a row written before they existed: every kind null, every old column as it
// was. The conformance kit can only ask a store to accept the kinds; this reads the table itself.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startEngines, PARITY_DATABASE_URL, PARITY_TIMEOUT, type Engines } from '../../lib/parity/harness';
import type { UsageRow } from '../../core/ports';

const active: { client?: PrismaClient; engine: 'postgres' | 'sqlite' } = { engine: 'postgres' };
vi.mock('../../lib/prisma', () => ({
  get prisma() { return active.client; },
  get dbEngine() { return active.engine; },
}));

import { prismaUsageStore } from './usageStore';

const KINDS = { cachedInputTokens: 1920, cacheWriteTokens: 2048, cacheWrite5mTokens: 1024, cacheWrite1hTokens: 1024, cacheMissTokens: 86, reasoningTokens: 0 };
const NONE  = Object.fromEntries(Object.keys(KINDS).map((k) => [k, null]));

const row = (id: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  id, sessionId: 's', modelId: 'gpt-4o', modelName: 'gpt-4o', provider: 'openai', inputTokens: 2006, outputTokens: 300,
  totalTokens: 2306, unit: 'token', quantity: 0, estimatedUsd: 0.008, outcome: 'success', latencyMs: 40, cached: false,
  savedUsd: 0, nexusTeamKeyId: null, teamId: null, createdAt: new Date('2026-10-01T00:00:00.000Z'), ...extra,
});

const select = {
  id: true, inputTokens: true, outputTokens: true, totalTokens: true, estimatedUsd: true, outcome: true,
  ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, true])),
};

describe.skipIf(!PARITY_DATABASE_URL)('Prisma usage store: token kinds', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  beforeAll(() => { e = startEngines('usage_kinds'); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  describe.each([['postgres'], ['sqlite']] as const)('%s', (engine) => {
    it('writes every reported kind, and reads a row without them as before', async () => {
      const db = engine === 'postgres' ? e.pg : e.sqlite;
      active.client = db;
      active.engine = engine;
      await db.tokenUsage.deleteMany({});

      await prismaUsageStore.insertBatch([
        row('with-kinds', { ...KINDS, outcome: 'client_cancelled' }),
        row('without'),
        row('zero-only', { cachedInputTokens: 0 }),
      ]);
      // A retried batch is still a no-op, kinds and all.
      await prismaUsageStore.insertBatch([row('with-kinds', KINDS)]);

      const rows = await db.tokenUsage.findMany({ select, orderBy: { id: 'asc' } });
      const base = { inputTokens: 2006, outputTokens: 300, totalTokens: 2306, estimatedUsd: 0.008 };
      expect(rows).toEqual([
        { id: 'with-kinds', ...base, outcome: 'client_cancelled', ...KINDS },
        { id: 'without',    ...base, outcome: 'success', ...NONE },
        { id: 'zero-only',  ...base, outcome: 'success', ...NONE, cachedInputTokens: 0 },
      ]);
    });
  });
});
