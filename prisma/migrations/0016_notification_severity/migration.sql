-- Notification severity (Phase 7.16c).
-- The alert feed had a `type` but no sense of how loud each alert is, so the panel could not tint a
-- dead key differently from a cooling breaker. One additive column, defaulting to "info" so every
-- existing row and any older writer stays valid — no existing row is touched.
ALTER TABLE "Notification" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';
