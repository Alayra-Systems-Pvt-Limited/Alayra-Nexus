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

// Audit & compliance HTTP surface (Phase 6.7). The audit trail is read-only over HTTP — there
// is deliberately no write or delete endpoint, so the log cannot be edited through the API;
// entries are written only by the automatic hook and the retention job removes them. Reads are
// open to any admin; changing the compliance policy requires an owner.
import { FastifyInstance } from 'fastify';
import { z }               from 'zod';
import { queryAuditLogs, getComplianceConfig, setComplianceConfig } from '../../services/audit.service';
import { MAX_RETENTION_DAYS } from '../../lib/audit';
import { adminGuard, adminOwnerGuard } from './guard';

const retentionDays = z.coerce.number().int().min(0).max(MAX_RETENTION_DAYS);

const complianceSchema = z.object({
  auditRetentionDays: retentionDays,
  usageRetentionDays: retentionDays,
  // Optional: a client written before the alert feed existed (Phase 7.11) must not have its
  // notification window silently reset to a default it never chose.
  notificationRetentionDays: retentionDays.optional(),
  anonymizeUsage:     z.boolean(),
});

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function adminAuditRoutes(fastify: FastifyInstance) {
  // ── Read the audit trail (filterable, newest first) ───────────────
  fastify.get('/admin/audit', adminGuard, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const entries = await queryAuditLogs({
      action:    q.action    || undefined,
      actorRole: q.actorRole || undefined,
      since:     parseDate(q.since),
      until:     parseDate(q.until),
      before:    parseDate(q.before),
      limit:     q.limit ? parseInt(q.limit, 10) : undefined,
    });
    return reply.send({ entries });
  });

  // ── Compliance policy (read: any admin; write: owner only) ────────
  fastify.get('/admin/settings/compliance', adminGuard, async (_req, reply) => {
    return reply.send(await getComplianceConfig());
  });

  fastify.put('/admin/settings/compliance', adminOwnerGuard, async (request, reply) => {
    const parsed = complianceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid compliance settings.' });
    await setComplianceConfig(parsed.data);
    return reply.send(await getComplianceConfig());
  });
}
