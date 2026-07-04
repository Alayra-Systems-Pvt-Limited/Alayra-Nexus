-- Phase 4: link TokenUsage rows to the NexusTeamKey that made the request
ALTER TABLE "TokenUsage"
  ADD COLUMN "nexusTeamKeyId" TEXT;

ALTER TABLE "TokenUsage"
  ADD CONSTRAINT "TokenUsage_nexusTeamKeyId_fkey"
  FOREIGN KEY ("nexusTeamKeyId")
  REFERENCES "NexusTeamKey"("id")
  ON DELETE SET NULL;

CREATE INDEX "TokenUsage_nexusTeamKeyId_idx" ON "TokenUsage"("nexusTeamKeyId");
