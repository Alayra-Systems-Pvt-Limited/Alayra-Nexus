/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// A standalone gateway with a history, for the migration suite to move.
//
// Separate from harness.ts because it is a different kind of seed. That one writes the SAME rows
// into two engines so a SQL twin can be compared; this one builds a plausible SQLite gateway that
// is about to be moved onto PostgreSQL, and every row in it is chosen to make one specific way the
// move could go wrong visible afterwards.
//
// ── What each part is here to catch ───────────────────────────────────────────────────────────
//
// EVERY model in MODEL_ORDER gets at least one row. A model with nothing in it is a model whose
// copy is not tested: source zero and target zero match, and the report says the move succeeded.
//
// TokenUsage crosses the page size three times over. `copyRows` reads in pages of 500 with a
// cursor, and cursor paging is exactly the sort of loop that silently drops the boundary row or
// hands one back twice — and a migration that loses one usage record in five hundred looks
// completely healthy in every count except the one nobody takes.
//
// The settings deliberately reuse the KEYS migration 0001 seeds, with the operator's real values.
// `inspectTarget` and `clearTarget` have to tell those apart by key AND value, and an earlier
// version of that rule matched on the marker string alone — which passed every test while quietly
// eating the one row whose placeholder is `[]` instead of `REPLACE_ON_INIT`.
//
// The secrets are ciphertext-shaped and non-ASCII on purpose. The whole reason this feature copies
// rows instead of exporting and restoring is that both ends share one master key, so an encrypted
// column can travel untouched. If any layer between the two engines re-encodes a string, every
// credential in the gateway arrives unopenable — and a length check would not notice.

import type { PrismaClient } from '@prisma/client';

/**
 * Usage rows written, chosen to cross `PAGE` (500 in pgMigrate.service) more than twice and end on
 * a partial page. 1201 exercises both loop exits: three full reads, then a short one.
 */
export const USAGE_ROWS = 1201;

/** Rows per insert. TokenUsage has ~17 columns, so this stays well inside SQLite's parameter cap. */
const BATCH = 100;

/**
 * Values that must arrive byte for byte, held here so the test asserts against the same constants
 * it seeded. Non-ASCII and base64 padding are both included because they are what a re-encoding
 * bug mangles first.
 */
export const SECRETS = {
  providerKey: 'v1:v8Jq2V+ZbG9y/V0=:ünïcødé-payload-Ω≈ç√:tag==',
  teamKey:     'v1:aGVsbG8gd29ybGQ=:キネティック-ciphertext:tag==',
  ssoSecret:   'v1:c2VjcmV0LXNzbw==:emoji-in-a-secret-🔐:tag==',
  totpSecret:  'v1:dG90cC1zZWNyZXQ=:JBSWY3DPEHPK3PXP:tag==',
  password:    'scrypt$16384$8$1$YWJjZGVmZ2g$3q2+7wAAAAABAgMEBQYHCAkKCwwNDg8=',
} as const;

/** The operator's own settings, under the same keys migration 0001 seeds with placeholders. */
export const REAL_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'NEXUS_API_KEY',     value: 'nx_live_9f3b2c1d8e7a6540' },
  { key: 'ENCRYPTION_SECRET', value: 'v1:bWFzdGVyLWtleQ==:the-real-one:tag==' },
  // The one a marker-only exclusion rule misses: its placeholder is `[]`, not `REPLACE_ON_INIT`.
  { key: 'AI_MODEL_REGISTRY', value: '[{"id":"gpt-4o","provider":"openai"}]' },
];

/** Every model's expected row count after seeding, so the test asserts totals it did not compute. */
export const SEEDED: Readonly<Record<string, number>> = {
  nexusProvider: 2,
  team: 2,
  adminUser: 2,
  adminAuth: 1,
  aiModelRegistry: 1,
  appSettings: REAL_SETTINGS.length,
  notification: 2,
  ssoProvider: 1,
  auditLog: 3,
  nexusKey: 2,
  nexusTeamKey: 3,
  adminInvite: 1,
  adminRecoveryCode: 2,
  adminApiToken: 2,
  domainAlias: 2,
  tokenUsage: USAGE_ROWS,
};

/** Stored backups, which must NOT travel. Seeded so their absence afterwards is a real observation. */
export const STORED_BACKUPS = { backup: 2, backupChunk: 3 };

const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 4, day, hour, 30, 0));

/** A delegate reduced to what this file calls, so the two clients can share one code path. */
type Db = PrismaClient;

/** Fill a SQLite gateway with the history above. Idempotent: everything is cleared first. */
export async function seedGateway(db: Db): Promise<void> {
  await clearGateway(db);

  await db.nexusProvider.createMany({ data: [
    { id: 'prov-1', name: 'OpenAI', slug: 'openai', provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      extraHeaders: '{"openai-beta":"assistants=v2"}', tier: 'standard', preferredModel: 'gpt-4o',
      createdAt: at(1), updatedAt: at(1) },
    { id: 'prov-2', name: 'Anthropic', slug: 'anthropic', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      extraHeaders: '{"anthropic-version":"2023-06-01"}', tier: 'premium', isActive: false,
      createdAt: at(1), updatedAt: at(2) },
  ] });

  await db.team.createMany({ data: [
    { id: 'team-1', name: 'Platform', budgetUsd: 250.75, budgetPeriod: 'monthly',
      overBudgetAction: 'downgrade', createdAt: at(1), updatedAt: at(3) },
    { id: 'team-2', name: 'Research', status: 'suspended', byokFallback: false,
      createdAt: at(2), updatedAt: at(2) },
  ] });

  await db.adminUser.createMany({ data: [
    { id: 'user-1', email: 'owner@example.com', name: 'The Owner', role: 'owner',
      passwordHash: SECRETS.password, totpSecret: SECRETS.totpSecret, totpConfirmedAt: at(2),
      lastLoginAt: at(4), createdAt: at(1), updatedAt: at(4) },
    // No password at all: an SSO account, where null is the enforcement rather than a missing value.
    { id: 'user-2', email: 'analyst@example.com', name: 'An Analyst', role: 'viewer',
      source: 'sso', passwordHash: null, createdAt: at(2), updatedAt: at(2) },
  ] });

  await db.adminAuth.create({ data: {
    id: 'singleton', totpSecret: null, confirmedAt: at(1), createdAt: at(1), updatedAt: at(2),
  } });

  await db.aiModelRegistry.create({ data: {
    id: 'registry-1', modelsJson: '[{"id":"gpt-4o"},{"id":"claude-opus-5"}]', updatedAt: at(3),
  } });

  await db.appSettings.createMany({
    data: REAL_SETTINGS.map((s, i) => ({ id: `setting-${i + 1}`, ...s, updatedAt: at(3) })),
  });

  await db.notification.createMany({ data: [
    { id: 'note-1', type: 'budgetThreshold', severity: 'warning', title: 'Team over 80%',
      body: 'Platform has used 80% of its monthly budget.', section: 'teams',
      dedupeKey: 'budget:team-1:80', createdAt: at(4) },
    { id: 'note-2', type: 'breakerOpened', severity: 'critical', title: 'Provider unavailable',
      body: 'Anthropic stopped answering.', dedupeKey: 'breaker:prov-2', readAt: at(5),
      createdAt: at(4) },
  ] });

  await db.ssoProvider.create({ data: {
    id: 'singleton', protocol: 'oidc', enabled: true, displayName: 'Corp SSO',
    issuer: 'https://sso.example.com', clientId: 'nexus', clientSecret: SECRETS.ssoSecret,
    roleClaim: 'groups', ownerValue: 'platform-admins', createdAt: at(1), updatedAt: at(3),
  } });

  await db.auditLog.createMany({ data: [
    { id: 'audit-1', action: 'auth.login', method: 'POST', actorRole: 'owner', actor: 'password',
      actorId: 'user-1', actorName: 'The Owner', status: 200, createdAt: at(4, 9) },
    { id: 'audit-2', action: 'keys.ban', method: 'POST', actorRole: 'owner', actorId: 'user-1',
      actorName: 'The Owner', target: 'key-1', status: 200,
      detail: '{"reason":"rotated"}', createdAt: at(4, 10) },
    // Written before accounts existed: no actor id, no name. It must survive exactly as it is.
    { id: 'audit-3', action: 'settings.update', method: 'PUT', actorRole: 'system', status: 204,
      createdAt: at(1, 8) },
  ] });

  await db.nexusKey.createMany({ data: [
    { id: 'key-1', providerId: 'prov-1', label: 'shared pool', encryptedKey: SECRETS.providerKey,
      maskedKey: 'sk-…001', rpmLimit: 120, tpmLimit: 250000, lastUsedAt: at(5),
      createdAt: at(1), updatedAt: at(5) },
    // BYOK: private to a team, so the copy has to land team-1 before this row.
    { id: 'key-2', providerId: 'prov-2', encryptedKey: 'v1:second::tag==', maskedKey: 'sk-…002',
      status: 'cooling', ownerTeamId: 'team-1', coolingUntil: at(6),
      createdAt: at(2), updatedAt: at(5) },
  ] });

  await db.nexusTeamKey.createMany({ data: [
    { id: 'tk-1', name: 'CI', encryptedKey: SECRETS.teamKey, keyHash: 'hash-1',
      maskedKey: 'nx-…001', teamId: 'team-1', createdAt: at(2) },
    { id: 'tk-2', name: 'Notebook', encryptedKey: 'v1:second-team::tag==', keyHash: 'hash-2',
      maskedKey: 'nx-…002', teamId: 'team-2', createdAt: at(3) },
    // Orphaned by design (teamId null), which the copy must preserve rather than repair.
    { id: 'tk-3', name: 'Legacy', encryptedKey: 'v1:third::tag==', keyHash: 'hash-3',
      maskedKey: 'nx-…003', teamId: null, createdAt: at(1) },
  ] });

  await db.adminInvite.create({ data: {
    id: 'invite-1', email: 'newcomer@example.com', role: 'admin', tokenHash: 'invite-hash-1',
    expiresAt: at(30), invitedById: 'user-1', createdAt: at(4),
  } });

  await db.adminRecoveryCode.createMany({ data: [
    { id: 'rc-1', codeHash: 'rc-hash-1', userId: 'user-1', createdAt: at(2) },
    { id: 'rc-2', codeHash: 'rc-hash-2', userId: 'user-1', usedAt: at(4), createdAt: at(2) },
  ] });

  await db.adminApiToken.createMany({ data: [
    { id: 'tok-1', name: 'deploy bot', tokenHash: 'tok-hash-1', maskedKey: 'nxa-…001',
      role: 'owner', createdById: 'user-1', lastUsedAt: at(5), createdAt: at(2) },
    { id: 'tok-2', name: 'revoked reader', tokenHash: 'tok-hash-2', maskedKey: 'nxa-…002',
      role: 'viewer', createdById: null, revokedAt: at(4), createdAt: at(3) },
  ] });

  await db.domainAlias.createMany({ data: [
    { id: 'dom-1', domain: 'api.example.com', teamId: 'team-1', status: 'verified',
      verificationToken: 'verify-1', verifiedAt: at(3), createdAt: at(2), updatedAt: at(3) },
    { id: 'dom-2', domain: 'lab.example.com', teamId: null, status: 'pending',
      verificationToken: 'verify-2', createdAt: at(3), updatedAt: at(3) },
  ] });

  // The large table, last — parents-first order and the real one both put it there.
  for (let start = 0; start < USAGE_ROWS; start += BATCH) {
    const rows = [];
    for (let i = start; i < Math.min(start + BATCH, USAGE_ROWS); i += 1) {
      rows.push({
        // Zero-padded so lexical order — which is what a string cursor pages by — matches the
        // order they were written. Unpadded, row 1000 sorts before row 2 and a paging bug that
        // depends on ordering would be hidden by the very ids meant to expose it.
        id: `usage-${String(i).padStart(5, '0')}`,
        sessionId: `sess-${i % 7}`,
        modelId: i % 3 === 0 ? 'gpt-4o' : 'claude-opus-5',
        modelName: i % 3 === 0 ? 'GPT-4o' : 'Claude Opus 5',
        provider: i % 3 === 0 ? 'openai' : 'anthropic',
        inputTokens: i, outputTokens: i * 2, totalTokens: i * 3,
        estimatedUsd: i / 1000,
        outcome: i % 50 === 0 ? 'upstream_error' : 'success',
        latencyMs: i % 11,
        cached: i % 13 === 0, savedUsd: i % 13 === 0 ? 0.25 : 0,
        // A third of them carry a foreign key, so the move has to land NexusTeamKey first.
        nexusTeamKeyId: i % 3 === 0 ? 'tk-1' : null,
        createdAt: at(1 + (i % 20), i % 24),
      });
    }
    await db.tokenUsage.createMany({ data: rows });
  }

  await seedStoredBackups(db);
}

/**
 * Two stored backups with their chunks — the rows the move deliberately leaves behind.
 *
 * Seeded so that "they did not travel" is something the test OBSERVES rather than assumes. An empty
 * source would satisfy the same assertion while proving nothing.
 */
async function seedStoredBackups(db: Db): Promise<void> {
  await db.backup.createMany({ data: [
    { id: 'bk-1', filename: 'alayra-nexus-backup-2026-05-01.nxb', bytes: 2048, rows: 900,
      origin: 'scheduled', createdAt: at(5) },
    { id: 'bk-2', filename: 'alayra-nexus-backup-2026-05-06.nxb', bytes: 3072, rows: 1200,
      origin: 'manual', createdAt: at(6) },
  ] });

  await db.backupChunk.createMany({ data: [
    { id: 'bc-1', backupId: 'bk-1', seq: 0, data: Buffer.from('first chunk of the older file') },
    { id: 'bc-2', backupId: 'bk-1', seq: 1, data: Buffer.from('second chunk of the older file') },
    { id: 'bc-3', backupId: 'bk-2', seq: 0, data: Buffer.from('the whole newer file') },
  ] });
}

/** Empty everything, children before parents, so a re-seed cannot trip a foreign key. */
export async function clearGateway(db: Db): Promise<void> {
  await db.backupChunk.deleteMany();
  await db.backup.deleteMany();
  await db.tokenUsage.deleteMany();
  await db.domainAlias.deleteMany();
  await db.adminApiToken.deleteMany();
  await db.adminRecoveryCode.deleteMany();
  await db.adminInvite.deleteMany();
  await db.nexusTeamKey.deleteMany();
  await db.nexusKey.deleteMany();
  await db.auditLog.deleteMany();
  await db.ssoProvider.deleteMany();
  await db.notification.deleteMany();
  await db.appSettings.deleteMany();
  await db.aiModelRegistry.deleteMany();
  await db.adminAuth.deleteMany();
  await db.adminUser.deleteMany();
  await db.team.deleteMany();
  await db.nexusProvider.deleteMany();
}
