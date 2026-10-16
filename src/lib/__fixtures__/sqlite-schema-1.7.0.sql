-- GENERATED FILE — DO NOT EDIT.
--
-- The schema a standalone gateway creates on first run, emitted by `prisma migrate diff` from
-- prisma/schema.sqlite.prisma and executed by src/lib/sqliteBootstrap.ts.
--
-- It is committed rather than produced at runtime because a gateway started with `npx` has no
-- Prisma CLI to hand and no network to fetch one — and the first thing it must do is create its own
-- database. Regenerate with `npm run db:sqlite-schema`; a drift test fails if this falls behind.

-- CreateTable
CREATE TABLE "NexusProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "modelFetchUrl" TEXT,
    "authHeader" TEXT NOT NULL DEFAULT 'Authorization',
    "authPrefix" TEXT,
    "modelIdPath" TEXT NOT NULL DEFAULT 'data[].id',
    "extraHeaders" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "preferredModel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NexusKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "label" TEXT,
    "encryptedKey" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "rpmLimit" INTEGER NOT NULL DEFAULT 60,
    "tpmLimit" INTEGER NOT NULL DEFAULT 100000,
    "maxUsers" INTEGER NOT NULL DEFAULT 1000,
    "lastUsedAt" DATETIME,
    "coolingUntil" DATETIME,
    "ownerTeamId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NexusKey_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "NexusProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NexusKey_ownerTeamId_fkey" FOREIGN KEY ("ownerTeamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiModelRegistry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelsJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'token',
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "estimatedUsd" REAL NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "savedUsd" REAL NOT NULL DEFAULT 0,
    "nexusTeamKeyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenUsage_nexusTeamKeyId_fkey" FOREIGN KEY ("nexusTeamKeyId") REFERENCES "NexusTeamKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedTier" TEXT,
    "budgetUsd" REAL,
    "budgetPeriod" TEXT NOT NULL DEFAULT 'monthly',
    "overBudgetAction" TEXT NOT NULL DEFAULT 'block',
    "byokFallback" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NexusTeamKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "teamId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NexusTeamKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "section" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'local',
    "totpSecret" TEXT,
    "totpConfirmedAt" DATETIME,
    "recoveryKeyHash" TEXT,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "invitedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAuth" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "totpSecret" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdById" TEXT,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminApiToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT '',
    "actorRole" TEXT NOT NULL DEFAULT 'system',
    "actor" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "target" TEXT,
    "ip" TEXT,
    "status" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SsoProvider" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "protocol" TEXT NOT NULL DEFAULT 'oidc',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL DEFAULT 'Single Sign-On',
    "issuer" TEXT NOT NULL DEFAULT '',
    "clientId" TEXT NOT NULL DEFAULT '',
    "clientSecret" TEXT NOT NULL DEFAULT '',
    "scopes" TEXT NOT NULL DEFAULT 'openid email profile',
    "roleClaim" TEXT NOT NULL DEFAULT '',
    "ownerValue" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DomainAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "teamId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DomainAlias_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bytes" INTEGER NOT NULL,
    "rows" INTEGER NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'scheduled'
);

-- CreateTable
CREATE TABLE "BackupChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "backupId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" BLOB NOT NULL,
    CONSTRAINT "BackupChunk_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "Backup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NexusProvider_slug_key" ON "NexusProvider"("slug");

-- CreateIndex
CREATE INDEX "NexusKey_providerId_status_idx" ON "NexusKey"("providerId", "status");

-- CreateIndex
CREATE INDEX "NexusKey_ownerTeamId_status_idx" ON "NexusKey"("ownerTeamId", "status");

-- CreateIndex
CREATE INDEX "TokenUsage_modelId_createdAt_idx" ON "TokenUsage"("modelId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_createdAt_idx" ON "TokenUsage"("createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_nexusTeamKeyId_idx" ON "TokenUsage"("nexusTeamKeyId");

-- CreateIndex
CREATE INDEX "TokenUsage_outcome_createdAt_idx" ON "TokenUsage"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NexusTeamKey_keyHash_key" ON "NexusTeamKey"("keyHash");

-- CreateIndex
CREATE INDEX "NexusTeamKey_teamId_idx" ON "NexusTeamKey"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_key_key" ON "AppSettings"("key");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_readAt_createdAt_idx" ON "Notification"("readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_role_status_idx" ON "AdminUser"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvite_tokenHash_key" ON "AdminInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminInvite_email_acceptedAt_idx" ON "AdminInvite"("email", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_userId_usedAt_idx" ON "AdminRecoveryCode"("userId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminApiToken_tokenHash_key" ON "AdminApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminApiToken_createdById_idx" ON "AdminApiToken"("createdById");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainAlias_domain_key" ON "DomainAlias"("domain");

-- CreateIndex
CREATE INDEX "DomainAlias_teamId_idx" ON "DomainAlias"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Backup_filename_key" ON "Backup"("filename");

-- CreateIndex
CREATE INDEX "Backup_createdAt_idx" ON "Backup"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupChunk_backupId_seq_key" ON "BackupChunk"("backupId", "seq");

