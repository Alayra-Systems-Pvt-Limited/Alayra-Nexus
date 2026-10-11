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

// ── Installing the open-source stores ─────────────────────────────────────────
// The install must hand the core one adapter per port, and those adapters must reach whatever
// lib/prisma resolves to at the first storage call (here a mock), never a client loaded earlier.

const findMany = vi.fn(async () => []);
vi.mock('../../lib/prisma', () => ({ prisma: { nexusProvider: { findMany } } }));

import { installPrismaCoreStores } from './install';
import { coreStores } from '../../core/stores';

describe('installPrismaCoreStores', () => {
  it('provides an adapter for every port', async () => {
    installPrismaCoreStores();
    const stores = await coreStores();
    expect(Object.keys(stores).sort()).toEqual(['keys', 'notifications', 'providers', 'settings', 'usage']);
  });

  it('loads the adapters lazily, so a mocked client is the one they use', async () => {
    installPrismaCoreStores();
    await (await coreStores()).providers.listActive();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
  });
});
