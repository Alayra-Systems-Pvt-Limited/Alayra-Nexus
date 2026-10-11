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

// The in-memory reference stores must pass every conformance check — and the checks must be able
// to fail, or a passing adapter proves nothing. Both halves are tested here.

import { describe, it, expect } from 'vitest';
import type { CoreStores, NotificationRow } from '../ports';
import {
  coreStoresConformance, runCoreStoresConformance, createMemoryCoreStores, CONFORMANCE_FIXTURE,
  type CoreStoresHarness,
} from '.';

function memoryHarness(tamper?: (s: CoreStores) => void): CoreStoresHarness {
  let notifications: NotificationRow[] = [];
  return {
    setup: async (fixture) => {
      const m = createMemoryCoreStores(fixture);
      notifications = m.notifications;
      tamper?.(m.stores);
      return m.stores;
    },
    notifications: async () => notifications,
  };
}

describe('the in-memory reference stores', () => {
  for (const c of coreStoresConformance) {
    it(c.name, () => c.run(memoryHarness()));
  }

  it('never mutates the shared fixture', async () => {
    const before = JSON.stringify(CONFORMANCE_FIXTURE);
    await runCoreStoresConformance(memoryHarness());
    expect(JSON.stringify(CONFORMANCE_FIXTURE)).toBe(before);
  });
});

describe('the conformance checks catch a broken adapter', () => {
  it('flags a store that ignores the team filter, and one that double-counts a retried batch', async () => {
    const failures = await runCoreStoresConformance(memoryHarness((s) => {
      const listRoutable = s.keys.listRoutable;
      s.keys.listRoutable = (providerId) => listRoutable(providerId, null);
      const seen: unknown[] = [];
      const insertBatch = s.usage.insertBatch;
      s.usage.insertBatch = async (rows) => {
        seen.push(...rows);
        await insertBatch(rows.map((r) => ({ ...r, id: `${r.id}-${seen.length}` })));
      };
    }));
    const names = failures.map((f) => f.name);
    expect(names).toContain('keys.listRoutable: a team sees only its own keys, and never a banned one');
    expect(names).toContain('usage.insertBatch: idempotent on id, so a retried batch is never counted twice');
  });

  it('reports every check by name', async () => {
    const names = coreStoresConformance.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(20);
  });
});
