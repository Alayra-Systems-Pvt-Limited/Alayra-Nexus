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

  // 2. Check team keys via SHA-256 hash (O(1) DB lookup, no decryption needed).
  // The team relation rides the same query so budget/status enforcement costs no
  // extra round-trip.
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const teamKey   = await prisma.nexusTeamKey.findUnique({ where: { keyHash: tokenHash }, include: { team: true } });
  if (teamKey) {
    if (teamKey.team?.status === 'suspended') {
      return reply.code(403).send({ error: 'This team is suspended. Contact your gateway administrator.' });
    }
    request.teamKeyId = teamKey.id;
    if (teamKey.team) {
      request.team = {
        id:           teamKey.team.id,
        budgetUsd:    teamKey.team.budgetUsd,
        budgetPeriod: teamKey.team.budgetPeriod,
        byokFallback: teamKey.team.byokFallback,
      };
    }
    return;
  }

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

/**
 * Guard for /metrics. Prometheus scrapes with a bearer token: a dedicated
 * METRICS_TOKEN if set (preferred — don't hand a scraper the admin password),
 * otherwise the admin password as a fallback. Never world-readable.
 */
export async function verifyMetricsToken(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token    = auth.slice(7);
  const expected = process.env.METRICS_TOKEN || process.env.ADMIN_PASSWORD;
  if (!expected || token !== expected) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
