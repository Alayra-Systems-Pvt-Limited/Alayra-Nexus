import { FastifyInstance } from 'fastify';
import { verifyApiKey }   from '../middleware/auth.middleware';
import { handleProxy }    from '../services/completionsProxy.service';
import type { CompletionsBody } from '../services/completionsProxy.service';

export default async function proxyRoutes(fastify: FastifyInstance) {
  // OpenAI-compatible completions endpoint
  // Users point Cursor / any tool here as Custom AI base URL
  fastify.post('/v1/chat/completions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    return handleProxy(request.body as CompletionsBody, reply);
  });

  // Models list — so Cursor can discover available models
  fastify.get('/v1/models', { preHandler: [verifyApiKey] }, async (_request, reply) => {
    const { getModelRegistry } = await import('../services/model.service');
    const registry = await getModelRegistry();
    const active   = registry.filter(m => m.status === 'active');
    return reply.send({
      object: 'list',
      data: active.map(m => ({
        id:       m.id,
        object:   'model',
        created:  Math.floor(Date.now() / 1000),
        owned_by: m.provider,
      })),
    });
  });
}
