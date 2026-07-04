import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash }   from 'crypto';
import { getSetting }   from '../services/settings.service';
import { prisma }       from '../lib/prisma';

export async function verifyApiKey(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Bearer token' });
  }
  const token = auth.slice(7);

  // 1. Check main Nexus API key
  const nexusKey = await getSetting('NEXUS_API_KEY');
  if (nexusKey && token === nexusKey) return;

  // 2. Check team keys via SHA-256 hash (O(1) DB lookup, no decryption needed)
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const teamKey   = await prisma.nexusTeamKey.findUnique({ where: { keyHash: tokenHash } });
  if (teamKey) return;

  return reply.code(401).send({ error: 'Invalid API key' });
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
