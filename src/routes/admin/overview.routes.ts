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

// The single aggregate read behind the redesigned landing screen (Phase 7.2). Read-only, so
// adminGuard (viewer or owner) is enough.
import { FastifyInstance } from 'fastify';
import { getOverview }     from '../../services/overview.service';
import { adminGuard }      from './guard';

export default async function adminOverviewRoutes(fastify: FastifyInstance) {
  fastify.get('/admin/overview', adminGuard, async (_req, reply) => {
    return reply.send(await getOverview());
  });
}
