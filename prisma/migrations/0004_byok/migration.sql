-- Phase 5.5: BYOK (Bring Your Own Key).
-- A provider key may be owned by a Team, making it private to that team's traffic.
-- Ownership lives on the credential rather than the provider, so a BYOK key reuses
-- the provider's shared config and the same admission / breaker / analytics path.
--
-- Additive and backward compatible: every existing key gets ownerTeamId = NULL,
-- which is exactly the shared pool. Existing routing behaviour is unchanged.
--
-- ON DELETE CASCADE is deliberate. SetNull (used elsewhere in this schema) would
-- release a deleted team's private credentials into the shared pool, where every
-- other caller could route through them.

ALTER TABLE "NexusKey" ADD COLUMN "ownerTeamId" TEXT;

ALTER TABLE "NexusKey"
  ADD CONSTRAINT "NexusKey_ownerTeamId_fkey"
  FOREIGN KEY ("ownerTeamId") REFERENCES "Team"("id") ON DELETE CASCADE;

CREATE INDEX "NexusKey_ownerTeamId_status_idx" ON "NexusKey"("ownerTeamId", "status");

-- Teams that own keys may fall back to the shared pool when their own keys are
-- exhausted. false = hard isolation. Default true preserves prior behaviour for
-- any team that later adds a key.
ALTER TABLE "Team" ADD COLUMN "byokFallback" BOOLEAN NOT NULL DEFAULT true;
