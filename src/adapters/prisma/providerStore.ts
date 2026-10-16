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

// ── Prisma provider store ─────────────────────────────────────────────────────
// The open-source gateway's provider pools, read exactly as the provider cache and the model
// registry read them before the port existed.

import { prisma } from '../../lib/prisma';
import type { ProviderCheckRow, ProviderRow, ProviderStore } from '../../core/ports';
import { KEY_ROUTING_ORDER } from './keyOrder';

/** The routing projection. `satisfies` keeps it in step with ProviderRow at compile time. */
const PROVIDER_SELECT = {
  id: true, baseUrl: true, provider: true, authHeader: true,
  authPrefix: true, tier: true, preferredModel: true, extraHeaders: true, nativeMessages: true,
} satisfies Record<keyof ProviderRow, true>;

/** The operator-check projection, kept in step with ProviderCheckRow the same way. */
export const PROVIDER_CHECK_SELECT = {
  baseUrl: true, provider: true, authHeader: true, authPrefix: true,
  extraHeaders: true, modelFetchUrl: true, modelIdPath: true,
} satisfies Record<keyof ProviderCheckRow, true>;

export const prismaProviderStore: ProviderStore = {
  // Oldest first: every caller filters this list in memory, so this order is selection order.
  listActive: () => prisma.nexusProvider.findMany({
    where:   { isActive: true },
    orderBy: { createdAt: 'asc' },
    select:  PROVIDER_SELECT,
  }),

  listPreferredModelPools: () => prisma.nexusProvider.findMany({
    where:  { isActive: true, preferredModel: { not: null } },
    select: { provider: true, preferredModel: true, tier: true, name: true },
  }),

  countActive: () => prisma.nexusProvider.count({ where: { isActive: true } }),

  // ── Operator checks ───────────────────────────────────────────────────────
  // Same where and the same key choice (one active key, least recently used) the checks issued
  // inline; the projection is narrowed to the columns they read.
  findForCheck: async (providerId) => {
    const row = await prisma.nexusProvider.findUnique({
      where:  { id: providerId },
      select: {
        ...PROVIDER_CHECK_SELECT,
        keys: { where: { status: 'active' }, take: 1, orderBy: KEY_ROUTING_ORDER, select: { encryptedKey: true } },
      },
    });
    if (!row) return null;
    const { keys, ...pool } = row;
    return { ...pool, activeKey: keys[0]?.encryptedKey ?? null };
  },
};
