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

import { describe, expect, it, vi } from 'vitest';
import { configureCoreStores, coreStores, resetCoreStoresForTests } from './stores';
import type { CoreStores } from './ports';

// ── The core store registry ───────────────────────────────────────────────────
// What a host relies on: the loader runs once, a failure is not cached, and a missing install is a
// clear error rather than an undefined property deep inside routing.

const fake = { keys: {}, providers: {}, usage: {}, settings: {}, notifications: {} } as unknown as CoreStores;

describe('coreStores', () => {
  it('rejects with an actionable message when nothing was installed', async () => {
    resetCoreStoresForTests();
    await expect(coreStores()).rejects.toThrow(/configureCoreStores/);
  });

  it('runs the loader once and reuses its stores', async () => {
    const loader = vi.fn(async () => fake);
    configureCoreStores(loader);
    const [a, b] = await Promise.all([coreStores(), coreStores()]);
    expect(a).toBe(fake);
    expect(b).toBe(fake);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('retries a loader that failed instead of caching the failure', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(fake);
    configureCoreStores(loader);
    await expect(coreStores()).rejects.toThrow('transient');
    await expect(coreStores()).resolves.toBe(fake);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('drops the cached stores when a host installs new ones', async () => {
    configureCoreStores(() => fake);
    await coreStores();
    const other = { ...fake } as CoreStores;
    configureCoreStores(() => other);
    await expect(coreStores()).resolves.toBe(other);
  });
});
