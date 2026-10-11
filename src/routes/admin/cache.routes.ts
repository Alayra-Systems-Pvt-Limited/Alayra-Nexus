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

// Response-cache operations for the Caching dashboard section (Phase 7.7).
//
// This is the *response* cache — identical-request replays served straight from Redis
// (see lib/responseCache.ts). It is deliberately distinct from the model-registry cache
// bust at POST /admin/cache/flush in system.routes.ts: the two clear different things and
// are audited under different slugs (cache.purge here, cache.flush there), so flush is
// left exactly as it is for the old dashboard's parity.
import { FastifyInstance } from 'fastify';
import { getCacheStats, purgeResponseCache } from '../../services/cacheStats.service';
import { adminGuard, adminWriteGuard } from './guard';

export default async function adminCacheRoutes(fastify: FastifyInstance) {
  // A viewer may read the operational figures.
  fastify.get('/admin/cache/stats', adminGuard, async (_req, reply) => {
    return reply.send(await getCacheStats());
  });

  // Owner-only, and recorded as `cache.purge` by the admin audit hook (a mutation, not excluded).
  fastify.post('/admin/cache/purge', adminWriteGuard, async (_req, reply) => {
    return reply.send(await purgeResponseCache());
  });
}
