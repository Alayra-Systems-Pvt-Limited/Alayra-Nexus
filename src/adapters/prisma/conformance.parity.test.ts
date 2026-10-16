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

// The open-source Prisma adapters against the core's conformance checks (P0.5c), on BOTH engines.
// The same checks the in-memory reference passes, and the same ones the hosted gateway's tenant
// stores will have to pass: three implementations held to one definition of "correct".
//
// The adapters read the shared `prisma` client from lib/prisma, so that module is replaced with
// one whose client and engine follow whichever database the current check is running against.

import { describe, it, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startEngines, PARITY_DATABASE_URL, PARITY_TIMEOUT, type Engines } from '../../lib/parity/harness';
import type { CoreFixture } from '../../core/testing';
import { coreStoresConformance, type CoreStoresHarness } from '../../core/testing';

// ── The client the adapters see ───────────────────────────────────────────────────────────────

const active: { client?: PrismaClient; engine: 'postgres' | 'sqlite' } = { engine: 'postgres' };
vi.mock('../../lib/prisma', () => ({
  get prisma() { return active.client; },
  get dbEngine() { return active.engine; },
}));

import { prismaCoreStores } from './index';

// ── Writing the fixture ───────────────────────────────────────────────────────────────────────

/** Empty every table the fixture touches, children before parents. */
async function clear(db: PrismaClient): Promise<void> {
  await db.tokenUsage.deleteMany({});
  await db.notification.deleteMany({});
  await db.nexusKey.deleteMany({});
  await db.nexusTeamKey.deleteMany({});
  await db.nexusProvider.deleteMany({});
  await db.team.deleteMany({});
  await db.appSettings.deleteMany({});
}

async function seed(db: PrismaClient, f: CoreFixture): Promise<void> {
  await db.team.createMany({ data: f.teams.map((t) => ({ id: t.id, name: t.name })) });
  await db.nexusTeamKey.createMany({
    data: f.teamKeys.map((k) => ({
      id: k.id, name: k.name, teamId: k.teamId,
      encryptedKey: `enc:${k.id}`, keyHash: `hash:${k.id}`, maskedKey: `nx-…${k.id}`,
    })),
  });
  await db.nexusProvider.createMany({
    data: f.providers.map((p) => ({
      id: p.id, name: p.name, slug: p.slug, provider: p.provider, baseUrl: p.baseUrl,
      authHeader: p.authHeader, authPrefix: p.authPrefix, tier: p.tier, preferredModel: p.preferredModel,
      extraHeaders: p.extraHeaders, nativeMessages: p.nativeMessages ?? null,
      modelFetchUrl: p.modelFetchUrl, modelIdPath: p.modelIdPath, isActive: p.isActive, createdAt: p.createdAt,
    })),
  });
  await db.nexusKey.createMany({
    data: f.keys.map((k) => ({
      id: k.id, providerId: k.providerId, ownerTeamId: k.ownerTeamId, status: k.status,
      maxUsers: k.maxUsers, rpmLimit: k.rpmLimit, tpmLimit: k.tpmLimit,
      encryptedKey: k.encryptedKey, maskedKey: k.maskedKey, lastUsedAt: k.lastUsedAt, coolingUntil: k.coolingUntil,
    })),
  });
  await db.appSettings.createMany({ data: f.settings.map((s) => ({ key: s.key, value: s.value })) });
}

function prismaHarness(engine: 'postgres' | 'sqlite', db: () => PrismaClient): CoreStoresHarness {
  return {
    setup: async (fixture) => {
      active.client = db();
      active.engine = engine;
      await clear(active.client);
      await seed(active.client, fixture);
      return prismaCoreStores;
    },
    notifications: async () => (await db().notification.findMany({ orderBy: { createdAt: 'asc' } }))
      .map((n) => ({
        id: n.id, type: n.type, severity: n.severity, title: n.title, body: n.body,
        section: n.section, dedupeKey: n.dedupeKey,
      })),
  };
}

// ── The checks, on each engine ────────────────────────────────────────────────────────────────

describe.skipIf(!PARITY_DATABASE_URL)('Prisma core stores conform', { timeout: PARITY_TIMEOUT }, () => {
  let e: Engines;
  beforeAll(() => { e = startEngines('conformance'); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  describe.each([['postgres'], ['sqlite']] as const)('%s', (engine) => {
    const harness = prismaHarness(engine, () => (engine === 'postgres' ? e.pg : e.sqlite));
    for (const c of coreStoresConformance) {
      it(c.name, () => c.run(harness));
    }
  });
});
