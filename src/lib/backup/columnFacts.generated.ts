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

// GENERATED FILE — DO NOT EDIT.
//
// Derived from prisma/schema.prisma by scripts/db/columnFacts.ts. Edit that schema and re-run
// `npm run db:column-facts`; CI fails if this falls behind, because a stale entry here makes the
// backup drift check describe a restore that cannot succeed as one that can.
//
// Why these two facts are not read from Prisma: scripts/db/columnFacts.ts explains it in full.

import type { ColumnFacts } from './columnFactsTypes';

export const COLUMN_FACTS: ColumnFacts = {
  AdminApiToken: {
    createdAt: 'req:def',
    createdById: 'opt:nodef',
    id: 'req:def',
    lastUsedAt: 'opt:nodef',
    maskedKey: 'req:nodef',
    name: 'req:nodef',
    revokedAt: 'opt:nodef',
    role: 'req:def',
    tokenHash: 'req:nodef',
  },
  AdminAuth: {
    confirmedAt: 'opt:nodef',
    createdAt: 'req:def',
    id: 'req:def',
    totpSecret: 'opt:nodef',
    updatedAt: 'req:def',
  },
  AdminInvite: {
    acceptedAt: 'opt:nodef',
    createdAt: 'req:def',
    email: 'req:nodef',
    expiresAt: 'req:nodef',
    id: 'req:def',
    invitedById: 'opt:nodef',
    role: 'req:def',
    tokenHash: 'req:nodef',
  },
  AdminRecoveryCode: {
    codeHash: 'req:nodef',
    createdAt: 'req:def',
    id: 'req:def',
    usedAt: 'opt:nodef',
    userId: 'opt:nodef',
  },
  AdminUser: {
    createdAt: 'req:def',
    email: 'req:nodef',
    id: 'req:def',
    lastLoginAt: 'opt:nodef',
    name: 'req:nodef',
    passwordHash: 'opt:nodef',
    recoveryKeyHash: 'opt:nodef',
    role: 'req:def',
    source: 'req:def',
    status: 'req:def',
    totpConfirmedAt: 'opt:nodef',
    totpSecret: 'opt:nodef',
    updatedAt: 'req:def',
  },
  AiModelRegistry: {
    id: 'req:def',
    modelsJson: 'req:nodef',
    updatedAt: 'req:def',
  },
  AppSettings: {
    id: 'req:def',
    key: 'req:nodef',
    updatedAt: 'req:def',
    value: 'req:nodef',
  },
  AuditLog: {
    action: 'req:nodef',
    actor: 'opt:nodef',
    actorId: 'opt:nodef',
    actorName: 'opt:nodef',
    actorRole: 'req:def',
    createdAt: 'req:def',
    detail: 'opt:nodef',
    id: 'req:def',
    ip: 'opt:nodef',
    method: 'req:def',
    status: 'req:def',
    target: 'opt:nodef',
  },
  Backup: {
    bytes: 'req:nodef',
    createdAt: 'req:def',
    filename: 'req:nodef',
    id: 'req:def',
    origin: 'req:def',
    rows: 'req:nodef',
  },
  BackupChunk: {
    backupId: 'req:nodef',
    data: 'req:nodef',
    id: 'req:def',
    seq: 'req:nodef',
  },
  DomainAlias: {
    createdAt: 'req:def',
    domain: 'req:nodef',
    id: 'req:def',
    status: 'req:def',
    teamId: 'opt:nodef',
    updatedAt: 'req:def',
    verificationToken: 'req:nodef',
    verifiedAt: 'opt:nodef',
  },
  NexusKey: {
    coolingUntil: 'opt:nodef',
    createdAt: 'req:def',
    encryptedKey: 'req:nodef',
    id: 'req:def',
    label: 'opt:nodef',
    lastUsedAt: 'opt:nodef',
    maskedKey: 'req:nodef',
    maxUsers: 'req:def',
    ownerTeamId: 'opt:nodef',
    providerId: 'req:nodef',
    rpmLimit: 'req:def',
    status: 'req:def',
    tpmLimit: 'req:def',
    updatedAt: 'req:def',
  },
  NexusProvider: {
    authHeader: 'req:def',
    authPrefix: 'opt:nodef',
    baseUrl: 'opt:nodef',
    createdAt: 'req:def',
    extraHeaders: 'opt:nodef',
    id: 'req:def',
    isActive: 'req:def',
    modelFetchUrl: 'opt:nodef',
    modelIdPath: 'req:def',
    name: 'req:nodef',
    preferredModel: 'opt:nodef',
    provider: 'req:nodef',
    slug: 'req:nodef',
    tier: 'req:def',
    updatedAt: 'req:def',
  },
  NexusTeamKey: {
    createdAt: 'req:def',
    encryptedKey: 'req:nodef',
    id: 'req:def',
    keyHash: 'req:nodef',
    maskedKey: 'req:nodef',
    name: 'req:nodef',
    teamId: 'opt:nodef',
  },
  Notification: {
    body: 'req:nodef',
    createdAt: 'req:def',
    dedupeKey: 'req:nodef',
    id: 'req:def',
    readAt: 'opt:nodef',
    section: 'opt:nodef',
    severity: 'req:def',
    title: 'req:nodef',
    type: 'req:nodef',
  },
  SsoProvider: {
    clientId: 'req:def',
    clientSecret: 'req:def',
    createdAt: 'req:def',
    displayName: 'req:def',
    enabled: 'req:def',
    id: 'req:def',
    issuer: 'req:def',
    ownerValue: 'req:def',
    protocol: 'req:def',
    roleClaim: 'req:def',
    scopes: 'req:def',
    updatedAt: 'req:def',
  },
  Team: {
    assignedTier: 'opt:nodef',
    budgetPeriod: 'req:def',
    budgetUsd: 'opt:nodef',
    byokFallback: 'req:def',
    createdAt: 'req:def',
    id: 'req:def',
    name: 'req:nodef',
    overBudgetAction: 'req:def',
    status: 'req:def',
    updatedAt: 'req:def',
  },
  TokenUsage: {
    cached: 'req:def',
    createdAt: 'req:def',
    estimatedUsd: 'req:def',
    id: 'req:def',
    inputTokens: 'req:def',
    latencyMs: 'req:def',
    modelId: 'req:nodef',
    modelName: 'req:nodef',
    nexusTeamKeyId: 'opt:nodef',
    outcome: 'req:def',
    outputTokens: 'req:def',
    provider: 'req:nodef',
    quantity: 'req:def',
    savedUsd: 'req:def',
    sessionId: 'req:nodef',
    totalTokens: 'req:def',
    unit: 'req:def',
  },
};
