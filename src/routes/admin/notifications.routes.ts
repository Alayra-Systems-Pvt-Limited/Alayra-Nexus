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

// The in-app alert feed behind the dashboard's bell (Phase 7.11).
//
// Marking read is a write, but it is deliberately open to any admin rather than owners only: read
// state is a personal convenience, not gateway configuration, and a viewer who cannot dismiss an
// alert would simply be stuck staring at a badge they have no way to clear.

import { FastifyInstance } from 'fastify';
import {
  listNotifications, markNotificationRead, markAllNotificationsRead,
} from '../../services/notificationFeed.service';
import { adminGuard } from './guard';

export default async function adminNotificationsRoutes(fastify: FastifyInstance) {
  fastify.get('/admin/notifications', adminGuard, async (request, reply) => {
    const q = request.query as { limit?: string; unread?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return reply.send(await listNotifications({
      // An unparseable limit falls back to the default rather than 400ing: this is a bell, and a
      // bad query string is not worth failing an operator's dashboard over.
      limit:      Number.isFinite(limit) ? limit : undefined,
      unreadOnly: q.unread === 'true',
    }));
  });

  fastify.post('/admin/notifications/:id/read', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const found  = await markNotificationRead(id);
    if (!found) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ success: true });
  });

  fastify.post('/admin/notifications/read-all', adminGuard, async (_req, reply) => {
    return reply.send({ success: true, marked: await markAllNotificationsRead() });
  });
}
