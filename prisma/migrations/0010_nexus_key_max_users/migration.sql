-- Nexus key user cap (Phase 7.4b): the maximum distinct end-users a provider key may
-- serve. Additive with a default so every existing key keeps working unchanged.
-- Stored and surfaced now; per-user admission enforcement is a later, separate change.
ALTER TABLE "NexusKey" ADD COLUMN "maxUsers" INTEGER NOT NULL DEFAULT 1000;
