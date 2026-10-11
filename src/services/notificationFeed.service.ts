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

// ── The in-app alert feed (Phase 7.11) ───────────────────────────────────────
// The store behind the dashboard's notifications bell. Alerts were email/webhook only and were
// never written down, so the bell had nothing to read — and because delivery is off until an
// operator configures a channel, a feed fed from the send path would have been empty on every
// default install. So recording is deliberately independent of delivery: every raised alert lands
// here, and the email/webhook config gates only whether it *also* leaves the building.
//
// This module owns reading, read-state and pruning. Recording an alert lives in
// notificationRecord.service.ts (P0.5a), which notifications.service calls with the coalescing
// window — the dependency runs one way, so there is no cycle. Config and delivery stay in
// notifications.service.

import { prisma }     from '../lib/prisma';

export interface NotificationRow {
  id: string; type: string; severity: string; title: string; body: string;
  section: string | null; read: boolean; createdAt: string;
}

const MAX_LIMIT = 100;

/** The feed for the bell: newest first, plus the unread count the badge shows. The count is always
 *  over *all* unread rows, never just the page — a badge that only counted the visible page would
 *  under-report the moment the feed grew past one screen. */
export async function listNotifications(opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<{
  notifications: NotificationRow[]; unreadCount: number;
}> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), MAX_LIMIT);
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where:   opts.unreadOnly ? { readAt: null } : {},
      orderBy: { createdAt: 'desc' },
      take:    limit,
    }),
    prisma.notification.count({ where: { readAt: null } }),
  ]);
  return {
    notifications: rows.map((n) => ({
      id: n.id, type: n.type, severity: n.severity, title: n.title, body: n.body,
      section: n.section, read: n.readAt !== null, createdAt: n.createdAt.toISOString(),
    })),
    unreadCount,
  };
}

/** Mark one alert read. Returns false when it does not exist, so the route can 404 honestly.
 *  Marking an already-read alert is a no-op, not an error — a double click is not a failure. */
export async function markNotificationRead(id: string): Promise<boolean> {
  const { count } = await prisma.notification.updateMany({
    where: { id, readAt: null },
    data:  { readAt: new Date() },
  });
  if (count > 0) return true;
  return (await prisma.notification.count({ where: { id } })) > 0;
}

/** Mark every unread alert read; returns how many changed. */
export async function markAllNotificationsRead(): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { readAt: null },
    data:  { readAt: new Date() },
  });
  return count;
}

/** Delete alerts older than `days`. `days <= 0` means keep forever — a no-op, matching the audit
 *  and usage windows. Read state is irrelevant here: an unread alert from months ago is stale, not
 *  precious, and keeping it forever would be the one table with no ceiling. */
export async function pruneNotifications(days: number): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
