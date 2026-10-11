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
import { verifyMasterApiKey } from '../services/apiKey.service';
import { prisma }       from '../lib/prisma';
import { safeEqual }    from '../lib/timingSafe';
import { resolveSession, verifyAdminApiToken, isPasswordBearerAllowed } from '../services/adminAuth.service';

export async function verifyApiKey(request: FastifyRequest, reply: FastifyReply) {
  // Accept both `Authorization: Bearer <key>` (OpenAI clients) and `x-api-key: <key>`
  // (Anthropic clients, notably Claude Code via ANTHROPIC_BASE_URL).
  const auth   = request.headers.authorization;
  const apiKey = request.headers['x-api-key'];
  const token = auth?.startsWith('Bearer ')
    ? auth.slice(7)
    : (typeof apiKey === 'string' ? apiKey : '');
  if (!token) {
    return reply.code(401).send({ error: 'Missing API key (Authorization: Bearer, or x-api-key)' });
  }

  // 1. Check the main Nexus API key. Compared as hashes (Phase 7.13a): the key is no longer stored
  // in plain text, so there is nothing to compare against directly. Hashing the candidate first
  // also removes the timing question — the digests are fixed-width and an attacker cannot walk a
  // prefix of one.
  if (await verifyMasterApiKey(token)) return;

  // 2. Check team keys via SHA-256 hash (O(1) DB lookup, no decryption needed).
  // The team relation rides the same query so budget/status enforcement costs no
  // extra round-trip. sha256 (not a slow password hash) is correct here: the token is a
  // high-entropy API key we issued, not a human password, so it is unguessable regardless,
  // and a fast digest is what makes the indexed keyHash lookup O(1).
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
        name:         teamKey.team.name,
        budgetUsd:    teamKey.team.budgetUsd,
        budgetPeriod: teamKey.team.budgetPeriod,
        byokFallback: teamKey.team.byokFallback,
        assignedTier: teamKey.team.assignedTier,
        overBudgetAction: teamKey.team.overBudgetAction,
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
 *   3. the raw ADMIN_PASSWORD — but ONLY while the gateway is unclaimed AND no second factor is
 *      confirmed.
 *
 * Rule 3 is the point of two phases at once. If the password kept working as a bearer token after
 * 2FA was enabled, anyone holding it would bypass the second factor and the feature would be
 * decorative (Phase 6). And if it kept working once accounts existed, the audit trail would go back
 * to saying "password" instead of a name, and nobody could ever truly be offboarded (Phase 7.13a).
 * Both doors stay open until the operator closes them, so upgrading changes nothing on its own.
 */
export async function verifyAdminPassword(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  // Resolve who is calling and attach them, so the guards — and any handler that writes an audit
  // entry — can read it. Order mirrors the credentials a caller may present: a dashboard session,
  // an admin API token, then the raw password.
  //
  // A session resolves against its account on every request, so a removed or suspended person is
  // refused here on their very next call rather than when their session happens to expire.
  const session = await resolveSession(token);
  if (session) {
    request.adminRole = session.role;
    if (session.userId) request.adminUserId = session.userId;
    if (session.name)   request.adminUserName = session.name;
    return;
  }

  const tokenRole = await verifyAdminApiToken(token);
  if (tokenRole) { request.adminRole = tokenRole; return; }

  if (!(await isPasswordBearerAllowed())) {
    return reply.code(401).send({
      error: 'Sign in at /admin/login for a session token, or use an admin API token.',
    });
  }

  if (!safeEqual(token, process.env.ADMIN_PASSWORD)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  request.adminRole = 'owner'; // the raw admin password is the owner, until the gateway is claimed
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
