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

// Writes the synthetic dataset from ./generator into a gateway's database, for screenshots and
// local exploration.
//
//   npm run seed              -- 30 days against the local gateway
//   npm run seed -- --days 14 --peak 900
//
// TWO RULES THIS SCRIPT WILL NOT BREAK:
//
//   1. It never deletes. There is no --clean, no truncate, no reset. Every write is an insert or an
//      upsert of a row it owns. A tool that can wipe a database is a tool that eventually does, and
//      this one exists to make screenshots look good — nowhere near enough reason to hold that gun.
//
//   2. It refuses to touch anything that is not local. The target must resolve to localhost, and a
//      remote host requires BOTH --allow-remote and typing the host back via --i-understand.
//      Seeding thousands of fabricated requests into a production gateway would corrupt real cost
//      reporting and a real audit trail, and would be indistinguishable from the genuine data
//      afterwards precisely because the generator works hard to look real.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../../src/lib/encryption';
import { generate, summarise, SEED_TEAMS, SEED_MODELS, type GeneratedData } from './generator';
import { assertSafeTarget } from './target';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

// ── Arguments ─────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAYS  = Number(arg('days') ?? 30);
const PEAK  = Number(arg('peak') ?? 1400);
const SEED  = Number(arg('seed') ?? 20260720);

// ── Writers ───────────────────────────────────────────────────────────────────

/** A fake credential that is obviously fake, so nobody mistakes seeded data for a real key. */
function fakeKey(prefix: string): string {
  return `${prefix}-SEED-${randomBytes(12).toString('hex')}`;
}

function mask(key: string): string {
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

async function seedTeamsAndKeys(): Promise<Map<string, string>> {
  const keyIdByName = new Map<string, string>();

  for (const team of SEED_TEAMS) {
    // Upsert by name so re-running does not pile up duplicate teams. Teams have no unique
    // constraint on name, so this is a find-then-create rather than a true upsert.
    const existing = await prisma.team.findFirst({ where: { name: team.name } });
    const row = existing ?? await prisma.team.create({
      data: {
        name:             team.name,
        budgetUsd:        team.budgetUsd,
        budgetPeriod:     team.budgetPeriod,
        overBudgetAction: team.overBudgetAction,
        status:           'active',
      },
    });

    for (const keyName of team.keyNames) {
      const existingKey = await prisma.nexusTeamKey.findFirst({ where: { name: keyName } });
      if (existingKey) { keyIdByName.set(keyName, existingKey.id); continue; }

      const plain = fakeKey('nxs');
      const created = await prisma.nexusTeamKey.create({
        data: {
          name:         keyName,
          teamId:       row.id,
          // The seeded access keys are not usable credentials and are not meant to be: the hash is
          // random, so no request can ever authenticate with one. They exist to give usage rows
          // something to attribute to and to populate the Teams tables.
          //
          // Sealed with the real encrypt() rather than filled with random bytes (see the provider
          // key below for what that cost).
          encryptedKey: encrypt(plain),
          keyHash:      randomBytes(32).toString('hex'),
          maskedKey:    mask(plain),
        },
      });
      keyIdByName.set(keyName, created.id);
    }
  }
  return keyIdByName;
}

async function seedProviderPools(): Promise<number> {
  const pools = [
    { name: 'Anthropic — Production',  slug: 'anthropic-prod',  provider: 'anthropic',  tier: 'premium',  keys: 3 },
    { name: 'OpenAI — Production',     slug: 'openai-prod',     provider: 'openai',     tier: 'premium',  keys: 2 },
    { name: 'Google — Gemini',         slug: 'google-gemini',   provider: 'google',     tier: 'standard', keys: 2 },
    { name: 'Groq — Fast tier',        slug: 'groq-fast',       provider: 'groq',       tier: 'fast',     keys: 2 },
    { name: 'OpenRouter — Overflow',   slug: 'openrouter-any',  provider: 'openrouter', tier: 'standard', keys: 1 },
  ];

  let keyCount = 0;
  for (const pool of pools) {
    const provider = await prisma.nexusProvider.upsert({
      where:  { slug: pool.slug },
      update: {},
      create: {
        name: pool.name, slug: pool.slug, provider: pool.provider,
        tier: pool.tier, isActive: true,
      },
    });

    const already = await prisma.nexusKey.count({ where: { providerId: provider.id } });
    for (let i = already; i < pool.keys; i++) {
      const plain = fakeKey(pool.provider);
      await prisma.nexusKey.create({
        data: {
          providerId:   provider.id,
          label:        `${pool.provider}-key-${i + 1}`,
          // Real ciphertext of a fake key — not random bytes.
          //
          // This used to be `randomBytes(48).toString('base64')`, reasoning that a seeded key which
          // could be decrypted was more dangerous than one that could not. The security instinct was
          // right; the implementation was wrong. `encryptedKey` has a contract — `iv:authTag:ciphertext`
          // produced by encrypt() — and random base64 does not meet it, so every feature that walks
          // secrets breaks on seeded data. The backup export is where it surfaced: it aborted the
          // whole export on the first seeded pool.
          //
          // Sealing a placeholder keeps both properties. The row is structurally valid, so the code
          // that reads it works; and what comes out is `openai-SEED-…`, which no provider will ever
          // accept, so it is still not a usable credential.
          encryptedKey: encrypt(plain),
          maskedKey:    mask(plain),
          status:       'active',
          rpmLimit:     [60, 120, 240][i % 3],
          tpmLimit:     [100_000, 250_000, 500_000][i % 3],
        },
      });
      keyCount++;
    }
  }
  return keyCount;
}

async function seedModelRegistry(): Promise<number> {
  const existingRaw = await prisma.appSettings.findUnique({ where: { key: 'AI_MODEL_REGISTRY' } });
  const existing: { id: string }[] = existingRaw ? JSON.parse(existingRaw.value) : [];
  const have = new Set(existing.map((m) => m.id));

  const additions = SEED_MODELS.filter((m) => !have.has(m.id)).map((m, i) => ({
    id: m.id, displayName: m.displayName, provider: m.provider, modelString: m.id,
    tier: m.tier, status: 'active', priority: i + 1,
    capabilities: ['chat'], hasVision: false, hasFIM: false, hasToolCalling: true,
    inputCostPer1M: m.inputCostPer1M, outputCostPer1M: m.outputCostPer1M,
  }));

  // Additive: an operator's hand-tuned entries are never overwritten by the seed.
  const merged = [...existing, ...additions];
  await prisma.appSettings.upsert({
    where:  { key: 'AI_MODEL_REGISTRY' },
    update: { value: JSON.stringify(merged) },
    create: { key: 'AI_MODEL_REGISTRY', value: JSON.stringify(merged) },
  });
  return additions.length;
}

async function seedUsage(data: GeneratedData, keyIdByName: Map<string, string>): Promise<number> {
  const rows = data.usage.map((u) => ({
    sessionId: u.sessionId, modelId: u.modelId, modelName: u.modelName, provider: u.provider,
    inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens,
    unit: 'token', quantity: u.totalTokens,
    estimatedUsd: u.estimatedUsd, outcome: u.outcome, latencyMs: u.latencyMs,
    cached: u.cached, savedUsd: u.savedUsd,
    nexusTeamKeyId: keyIdByName.get(u.teamKeyName) ?? null,
    createdAt: u.createdAt,
  }));

  // Chunked: a month of traffic is tens of thousands of rows and a single createMany of that size
  // is a needlessly large statement to hand the driver.
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.tokenUsage.createMany({ data: rows.slice(i, i + CHUNK) });
  }
  return rows.length;
}

async function seedAudit(data: GeneratedData): Promise<number> {
  const CHUNK = 500;
  const rows = data.audit.map((a) => ({
    action: a.action, method: a.method, actorRole: a.actorRole,
    actorName: a.actorName || null, actor: a.actorRole === 'system' ? null : 'password',
    target: a.target, status: a.status, ip: '203.0.113.10', createdAt: a.createdAt,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.auditLog.createMany({ data: rows.slice(i, i + CHUNK) });
  }
  return rows.length;
}

async function seedNotifications(data: GeneratedData): Promise<number> {
  let written = 0;
  for (const n of data.notifications) {
    const exists = await prisma.notification.findFirst({ where: { dedupeKey: n.dedupeKey } });
    if (exists) continue;
    await prisma.notification.create({
      data: {
        type: n.type, severity: n.severity, title: n.title, body: n.body,
        section: n.section, dedupeKey: n.dedupeKey, readAt: n.readAt, createdAt: n.createdAt,
      },
    });
    written++;
  }
  return written;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const host = assertSafeTarget({
    databaseUrl:   process.env.DATABASE_URL,
    allowRemote:   flag('allow-remote'),
    confirmedHost: arg('i-understand'),
  });

  const data = generate({ now: new Date(), days: DAYS, seed: SEED, peakRequestsPerDay: PEAK });
  const totals = summarise(data);

  console.log(`\nSeeding ${host} — ${DAYS} days, seed ${SEED}\n`);

  const keyIdByName  = await seedTeamsAndKeys();
  const providerKeys = await seedProviderPools();
  const models       = await seedModelRegistry();
  const usage        = await seedUsage(data, keyIdByName);
  const audit        = await seedAudit(data);
  const notes        = await seedNotifications(data);

  console.log(`  teams            ${SEED_TEAMS.length}`);
  console.log(`  team access keys ${keyIdByName.size}`);
  console.log(`  provider keys    ${providerKeys} new`);
  console.log(`  models           ${models} new registry entries`);
  console.log(`  usage rows       ${usage}`);
  console.log(`  audit rows       ${audit}`);
  console.log(`  notifications    ${notes} new`);
  console.log(`\n  ${totals.successful} successful of ${totals.requests} requests`);
  console.log(`  ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out tokens`);
  console.log(`  $${totals.costUsd.toFixed(2)} spend, $${totals.savedUsd.toFixed(2)} saved by cache`);
  console.log(`  ${(totals.cacheHitRate * 100).toFixed(1)}% cache hit rate\n`);
}

main()
  .catch((err) => { console.error(`\n${err instanceof Error ? err.message : err}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
