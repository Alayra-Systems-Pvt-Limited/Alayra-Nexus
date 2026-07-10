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

// The model registry.
import { FastifyInstance }      from 'fastify';
import { getModelRegistry, updateModelRegistry } from '../../services/model.service';
import { adminGuard }           from './guard';

export default async function adminModelsRoutes(fastify: FastifyInstance) {
  // ── Model Registry ────────────────────────────────────────────────

  fastify.get('/admin/models', adminGuard, async (_req, reply) => {
    const models = await getModelRegistry();
    return reply.send({ models });
  });

  fastify.put('/admin/models', adminGuard, async (request, reply) => {
    const { models } = request.body as { models: Parameters<typeof updateModelRegistry>[0] };
    await updateModelRegistry(models);
    return reply.send({ success: true });
  });
}
