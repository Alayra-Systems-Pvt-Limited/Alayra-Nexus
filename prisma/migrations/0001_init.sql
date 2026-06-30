CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "NexusProvider" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"          TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "provider"      TEXT NOT NULL,
  "baseUrl"       TEXT,
  "modelFetchUrl" TEXT,
  "authHeader"    TEXT NOT NULL DEFAULT 'Authorization',
  "authPrefix"    TEXT,
  "modelIdPath"   TEXT NOT NULL DEFAULT 'data[].id',
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NexusProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NexusProvider_slug_key" ON "NexusProvider"("slug");

CREATE TABLE "NexusKey" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "providerId"      TEXT NOT NULL,
  "label"           TEXT,
  "encryptedKey"    TEXT NOT NULL,
  "maskedKey"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'active',
  "rpmLimit"        INTEGER NOT NULL DEFAULT 60,
  "tpmLimit"        INTEGER NOT NULL DEFAULT 100000,
  "maxUsers"        INTEGER NOT NULL DEFAULT 10,
  "currentUsers"    INTEGER NOT NULL DEFAULT 0,
  "availableModels" TEXT[] NOT NULL DEFAULT '{}',
  "lastUsedAt"      TIMESTAMP(3),
  "coolingUntil"    TIMESTAMP(3),
  "errorCount"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NexusKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NexusKey_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "NexusProvider"("id") ON DELETE CASCADE
);
CREATE INDEX "NexusKey_providerId_status_idx" ON "NexusKey"("providerId", "status");

CREATE TABLE "TokenUsage" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "sessionId"    TEXT NOT NULL,
  "modelId"      TEXT NOT NULL,
  "modelName"    TEXT NOT NULL,
  "provider"     TEXT NOT NULL,
  "inputTokens"  INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens"  INTEGER NOT NULL DEFAULT 0,
  "estimatedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TokenUsage_modelId_createdAt_idx" ON "TokenUsage"("modelId", "createdAt");
CREATE INDEX "TokenUsage_createdAt_idx" ON "TokenUsage"("createdAt");

CREATE TABLE "AppSettings" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppSettings_key_key" ON "AppSettings"("key");

-- Seed: generated API key for the proxy endpoint (user pastes this into Cursor)
INSERT INTO "AppSettings" ("id","key","value","updatedAt") VALUES
  (gen_random_uuid()::text, 'NEXUS_API_KEY', 'REPLACE_ON_INIT', NOW()),
  (gen_random_uuid()::text, 'ENCRYPTION_SECRET', 'REPLACE_ON_INIT', NOW()),
  (gen_random_uuid()::text, 'AI_MODEL_REGISTRY', '[]', NOW());
