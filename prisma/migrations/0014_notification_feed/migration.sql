-- The in-app operator alert feed (Phase 7.11).
-- Alerts were email/webhook only and were never persisted, so the dashboard bell had nothing to read.
-- A new table rather than a column anywhere: an alert is its own entity with its own lifetime and its
-- own read state. Purely additive — no existing table or row is touched.
CREATE TABLE "Notification" (
    "id"        TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "body"      TEXT NOT NULL,
    "section"   TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- The feed is read newest-first, and the unread badge counts `readAt IS NULL` over that same order.
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "Notification_readAt_createdAt_idx" ON "Notification"("readAt", "createdAt");
