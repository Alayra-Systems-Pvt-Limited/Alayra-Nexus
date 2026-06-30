import { FastifyRequest, FastifyReply } from 'fastify';
import { getSetting } from '../services/settings.service';

export async function verifyApiKey(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Bearer token' });
  }
  const token   = auth.slice(7);
  const nexusKey = await getSetting('NEXUS_API_KEY');
  if (!nexusKey || token !== nexusKey) {
    return reply.code(401).send({ error: 'Invalid API key' });
  }
}

export async function verifyAdminPassword(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token    = auth.slice(7);
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd || token !== adminPwd) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
