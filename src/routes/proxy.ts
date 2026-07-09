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

import { FastifyInstance } from 'fastify';
import { verifyApiKey }   from '../middleware/auth.middleware';
import { handleProxy }    from '../services/completionsProxy.service';
import type { CompletionsBody } from '../services/completionsProxy.service';

export default async function proxyRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/chat/completions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const teamKeyId = request.teamKeyId;
    return handleProxy(request.body as CompletionsBody, reply, teamKeyId, request.headers as Record<string, unknown>);
  });

  fastify.get('/v1/models', { preHandler: [verifyApiKey] }, async (_request, reply) => {
    return reply.send({
      object: 'list',
      data: [{
        id:       'alayra-nexus-1',
        object:   'model',
        created:  Math.floor(Date.now() / 1000),
        owned_by: 'alayra-nexus',
      }],
    });
  });
}
