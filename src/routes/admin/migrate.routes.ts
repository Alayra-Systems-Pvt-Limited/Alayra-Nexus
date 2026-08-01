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

// Moving to PostgreSQL, over HTTP (Phase S3).
//
// ── Owner only, and rate limited ──────────────────────────────────────────────────────────────
//
// The body of these requests is a database administrator's credential, and the second of them
// reads every row this gateway holds and writes it somewhere else. That is the same class of
// action as an export, and it carries the same guard.
//
// The rate limit is on `inspect` for a reason beyond abuse: it opens a connection to an arbitrary
// host the caller names. Unbounded, it would let an authenticated owner use the gateway to probe
// hosts it can reach and they cannot, and time the answers. Owner-only makes that a small risk;
// the limit makes it a bounded one.
//
// ── Why the connection string is never audited ────────────────────────────────────────────────
//
// It contains a password. The audit trail is designed to be kept, exported and read by people who
// were not there — recording a live production credential in it would turn the one durable record
// of who did what into a place credentials leak from. `describeTarget` reduces it to host and
// database name, which is what an auditor actually needs: WHERE the data went, not how to get in.

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminOwnerGuard } from './guard';
import { AUTH_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';
import { recordAudit } from '../../services/audit.service';
import { actor } from './backup.routes';
import { dbEngine } from '../../lib/prisma';
import { inspectTarget, migrateToPostgres } from '../../services/pgMigrate.service';
import { describeTarget, NOT_MIGRATED } from '../../lib/migrateTarget';

const body = z.object({ url: z.string().min(1).max(4096) });

export default async function adminMigrateRoutes(fastify: FastifyInstance) {
  // What this gateway is running on, and therefore whether the move applies at all. Cheap, and the
  // screen needs it before it can decide what to render.
  fastify.get('/admin/migrate/status', adminOwnerGuard, async (_request, reply) => {
    return reply.header('cache-control', 'no-store').send({
      engine: dbEngine,
      canMigrate: dbEngine === 'sqlite',
      notMigrated: NOT_MIGRATED,
    });
  });

  // Look, change nothing. Answers the three questions the operator cannot answer from the string
  // alone: can it be reached, what is it, and is it already holding somebody's data.
  fastify.post('/admin/migrate/inspect', withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a Postgres connection string.' });

    const report = await inspectTarget(parsed.data.url);
    recordAudit({
      action: 'migrate.inspect', method: 'POST', ...actor(request),
      status: report.reachable ? 200 : 400,
      detail: JSON.stringify({ target: describeTarget(parsed.data.url), reachable: report.reachable }),
    });
    return reply.header('cache-control', 'no-store').send(report);
  });

  // The move itself. Long-running by nature: the gateway refuses traffic for its duration and the
  // client waits, because a migration that returned early and continued in the background would
  // leave nobody able to say whether it had finished.
  fastify.post('/admin/migrate/run', withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a Postgres connection string.' });

    const outcome = await migrateToPostgres(parsed.data.url);

    recordAudit({
      action: 'migrate.run', method: 'POST', ...actor(request),
      status: outcome.ok ? 200 : 500,
      detail: JSON.stringify({
        target: outcome.target,
        ok: outcome.ok,
        rowsCopied: outcome.rowsCopied ?? null,
        mismatches: outcome.mismatches?.length ?? 0,
        error: outcome.error ?? null,
      }),
    });

    // 200 even for a refusal the operator caused — an unreachable host, a database already in use.
    // The outcome carries `ok` and the sentence explaining it, and the wizard renders that far
    // better than it renders an HTTP error. A 5xx is reserved for the gateway's own failures.
    return reply.header('cache-control', 'no-store').send(outcome);
  });
}
