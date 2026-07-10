-- Phase 6: admin authentication hardening + custom-domain storage.
--
-- Additive. Nothing here changes behaviour on its own: with no AdminAuth row and no
-- confirmed TOTP secret, the gateway keeps accepting ADMIN_PASSWORD as a bearer token
-- exactly as before. Enrolling a second factor is what switches enforcement on.

-- The admin's second factor. One row, id = 'singleton'. totpSecret is AES-256-GCM
-- encrypted with MASTER_ENCRYPTION_KEY, never plaintext. confirmedAt stays NULL
-- between enrolment and the first verified code, so an abandoned enrolment cannot
-- lock the operator out.
CREATE TABLE "AdminAuth" (
  "id"          TEXT NOT NULL DEFAULT 'singleton',
  "totpSecret"  TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuth_pkey" PRIMARY KEY ("id")
);

-- Single-use fallbacks for a lost authenticator. Only the hash is stored.
CREATE TABLE "AdminRecoveryCode" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- Long-lived credentials for scripts and CI, which cannot present a second factor.
-- Revocation is a timestamp rather than a delete, so the audit trail survives.
CREATE TABLE "AdminApiToken" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"       TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "maskedKey"  TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminApiToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminApiToken_tokenHash_key" ON "AdminApiToken"("tokenHash");

-- Custom domains. A table, not a column on Team: a team may map several hostnames and
-- each needs its own verification state, which Phase 7's UI will drive.
CREATE TABLE "DomainAlias" (
  "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "domain"            TEXT NOT NULL,
  "teamId"            TEXT,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "verificationToken" TEXT NOT NULL,
  "verifiedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DomainAlias_domain_key" ON "DomainAlias"("domain");
CREATE INDEX "DomainAlias_teamId_idx" ON "DomainAlias"("teamId");

ALTER TABLE "DomainAlias"
  ADD CONSTRAINT "DomainAlias_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;
