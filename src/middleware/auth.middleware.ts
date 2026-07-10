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
import { safeEqual }    from '../lib/timingSafe';
import { isValidSession, verifyAdminApiToken, isTwoFactorEnabled } from '../services/adminAuth.service';

export async function verifyApiKey(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Bearer token' });
  }
  const token = auth.slice(7);

  // 1. Check main Nexus API key. Constant-time: `===` short-circuits at the first
  // differing byte, so rejection latency reveals how many leading bytes were right.
  const nexusKey = await getSetting('NEXUS_API_KEY');
  if (safeEqual(token, nexusKey)) return;

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

/**
 * Guard for every /admin route. A caller may present, in order of preference:
 *
 *   1. a dashboard session token from POST /admin/login,
 *   2. an admin API token (for scripts and CI, which cannot present a second factor),
 *   3. the raw ADMIN_PASSWORD — but ONLY while no second factor is confirmed.
 *
 * Rule 3 is the whole point of the phase. If the password kept working as a bearer
 * token after 2FA was enabled, anyone holding it would bypass the second factor and
 * the feature would be decorative. It stays accepted before enrolment so that
 * upgrading the gateway changes nothing for existing operators.
 */
export async function verifyAdminPassword(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  if (await isValidSession(token)) return;
  if (await verifyAdminApiToken(token)) return;

  if (await isTwoFactorEnabled()) {
    return reply.code(401).send({
      error: 'Two-factor authentication is enabled. Sign in at /admin/login for a session token, or use an admin API token.',
    });
  }

  if (!safeEqual(token, process.env.ADMIN_PASSWORD)) {
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
  if (!safeEqual(token, expected)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
