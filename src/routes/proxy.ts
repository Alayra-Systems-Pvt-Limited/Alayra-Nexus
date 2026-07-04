import { FastifyInstance } from 'fastify';
import { verifyApiKey }   from '../middleware/auth.middleware';
import { handleProxy }    from '../services/completionsProxy.service';
import type { CompletionsBody } from '../services/completionsProxy.service';

export default async function proxyRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/chat/completions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const teamKeyId = (request as Record<string, unknown>).teamKeyId as string | undefined;
    return handleProxy(request.body as CompletionsBody, reply, teamKeyId);
  });

  // Always returns just "nexus" — that's the only model name users need
  fastify.get('/v1/models', { preHandler: [verifyApiKey] }, async (_request, reply) => {
    return reply.send({
      object: 'list',
      data: [{
        id:       'nexus',
        object:   'model',
        created:  Math.floor(Date.now() / 1000),
        owned_by: 'kinetic-nexus',
      }],
    });
  });
}
