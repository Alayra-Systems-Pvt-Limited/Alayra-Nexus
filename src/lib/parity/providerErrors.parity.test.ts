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

// A caller hanging up is not the provider's fault, so the per-provider error count leaves it out,
// on both engines. Its own small seed rather than a row in the shared one: the shared seed's totals
// are asserted across every analytics query, and a cancel there would move all of them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEngines, runBoth, normalise, PARITY_DATABASE_URL, PARITY_TIMEOUT, T0, UNTIL, type Engines } from './harness';
import { ANALYTICS_BY_PROVIDER } from '../../services/analytics.service';

const ROWS: Array<[provider: string, outcome: string]> = [
  ['openai', 'success'], ['openai', 'client_cancelled'], ['openai', 'client_cancelled'],
  ['openai', 'upstream_error'], ['openai', 'client_error'],
  ['anthropic', 'success'], ['anthropic', 'client_cancelled'],
];

describe.skipIf(!PARITY_DATABASE_URL)('per-provider errors leave out client cancels', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  beforeAll(async () => {
    e = startEngines('provider_errors');
    for (const db of [e.pg, e.sqlite]) {
      await db.tokenUsage.deleteMany({});
      await db.tokenUsage.createMany({ data: ROWS.map(([provider, outcome], i) => ({
        id: `pe-${i}`, sessionId: 's', modelId: 'm', modelName: 'm', provider, outcome,
        createdAt: new Date(T0.getTime() + (i + 1) * 3_600_000),
      })) });
    }
  }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('counts every request, and only provider-side failures as errors', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_PROVIDER(T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const by = new Map(normalise(pg).map((r) => [(r as { provider: string }).provider, r as Record<string, number>]));
    expect(by.get('openai')).toMatchObject({ requests: 5, errors: 2 });       // upstream_error + client_error
    expect(by.get('anthropic')).toMatchObject({ requests: 2, errors: 0 });    // a cancel alone is no error
  });
});
