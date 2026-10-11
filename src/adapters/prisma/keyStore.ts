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

// ── Prisma key store ──────────────────────────────────────────────────────────
// The open-source gateway's answer to the core's KeyStore port. Every query here is the one the
// router issued inline before the port existed (same where and projection). The one deliberate
// change since is the routing order's explicit NULL placement and id tie-break (#195).

import { prisma } from '../../lib/prisma';
import type { KeyRow, KeyStore } from '../../core/ports';
import { PROVIDER_CHECK_SELECT } from './providerStore';
import { KEY_ROUTING_ORDER } from './keyOrder';

/** Usable = may be routed to. Banned keys never are; cooling keys may probe via the breaker. */
const USABLE = { in: ['active', 'cooling'] };

/** The routing projection. `satisfies` keeps it in step with KeyRow at compile time. */
const KEY_ROW_SELECT = {
  id: true, providerId: true, status: true, ownerTeamId: true,
  maxUsers: true, rpmLimit: true, tpmLimit: true, encryptedKey: true,
} satisfies Record<keyof KeyRow, true>;

export const prismaKeyStore: KeyStore = {
  // ── Routing reads ─────────────────────────────────────────────────────────
  listRoutable: (providerId, ownerTeamId) => prisma.nexusKey.findMany({
    where:   { providerId, status: USABLE, ownerTeamId },
    orderBy: KEY_ROUTING_ORDER,
    select:  KEY_ROW_SELECT,
  }),

  findRoutable: (keyId) => prisma.nexusKey.findUnique({ where: { id: keyId }, select: KEY_ROW_SELECT }),

  // ── State writes ──────────────────────────────────────────────────────────
  // `updateMany` where nothing reads the row back: Prisma's `update` compiles to a RETURNING of
  // every column. The two `update` calls stay `update` because that is what they always were.
  touchLastUsed: async (keyId, at) => {
    await prisma.nexusKey.updateMany({ where: { id: keyId }, data: { lastUsedAt: at } });
  },

  markBanned: async (keyId) => {
    await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'banned' } });
  },

  markCooling: async (keyId, until) => {
    await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'cooling', coolingUntil: until } });
  },

  markRecovered: async (keyId) => {
    await prisma.nexusKey.updateMany({
      where: { id: keyId, status: 'cooling' },
      data:  { status: 'active', coolingUntil: null },
    });
  },

  // ── Operator facts ────────────────────────────────────────────────────────
  nextCoolingUntil: async () => {
    const cooling = await prisma.nexusKey.findFirst({
      where:   { status: 'cooling', coolingUntil: { not: null } },
      orderBy: { coolingUntil: 'asc' },
    });
    return cooling?.coolingUntil ?? null;
  },

  alertFacts: async (keyId) => {
    const k = await prisma.nexusKey.findUnique({
      where: { id: keyId }, select: { maskedKey: true, provider: { select: { slug: true } } },
    });
    return k ? { maskedKey: k.maskedKey, providerSlug: k.provider.slug } : null;
  },

  // ── BYOK and catalog counts ───────────────────────────────────────────────
  countOwnedUsable: (teamId) => prisma.nexusKey.count({ where: { ownerTeamId: teamId, status: USABLE } }),

  ownedProviderSlugs: async (teamId) => {
    const rows = await prisma.nexusKey.findMany({
      where:  { ownerTeamId: teamId, status: USABLE },
      select: { provider: { select: { provider: true, isActive: true } } },
    });
    return new Set(rows.filter((r) => r.provider.isActive).map((r) => r.provider.provider));
  },

  countUsable: () => prisma.nexusKey.count({ where: { status: USABLE } }),

  listStates: () => prisma.nexusKey.findMany({ select: { status: true, coolingUntil: true } }),

  // ── Operator checks ───────────────────────────────────────────────────────
  findForCheck: (keyId) => prisma.nexusKey.findUnique({
    where:  { id: keyId },
    select: { encryptedKey: true, provider: { select: PROVIDER_CHECK_SELECT } },
  }),
};
