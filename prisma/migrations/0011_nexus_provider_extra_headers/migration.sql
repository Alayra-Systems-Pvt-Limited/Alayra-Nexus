-- Extra request headers merged into every outbound call to a provider (JSON object string).
-- Nullable and additive: existing pools keep sending only their auth header until one is set.
ALTER TABLE "NexusProvider" ADD COLUMN "extraHeaders" TEXT;
