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

// The stored backups, listed and downloadable (Phase B2).
//
// Separate from backup.routes.ts because that file is already the export, the restore, the dry run,
// the maintenance probe and the schedule. These three endpoints are one idea — the archive the
// gateway keeps of itself — and they are the reason an operator can recover without server access.
//
// ── Owner only, and never cached ──────────────────────────────────────────────────────────────
//
// A stored backup is every provider key, every team key and every TOTP secret in one file. The
// download is the same disclosure as /admin/backup/export and carries the same guard. `no-store` is
// not politeness: without it a shared proxy is entitled to keep a copy of the gateway's credentials.

import { FastifyInstance } from 'fastify';
import { adminOwnerGuard } from './guard';
import { AUTH_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';
import { recordAudit } from '../../services/audit.service';
import { actor } from './backup.routes';
import {
  listStoredBackups, findStoredBackup, deleteStoredBackup, readStoredBackup,
} from '../../lib/backup/backupStore';
import { isBackupFilename } from '../../lib/backupSchedule';

export default async function adminBackupArchiveRoutes(fastify: FastifyInstance) {
  // The list. Cheap — it never touches a chunk row, so a gateway holding gigabytes of backups
  // answers this as fast as one holding none.
  fastify.get('/admin/backup/archive', adminOwnerGuard, async (_request, reply) => {
    const backups = await listStoredBackups();
    return reply.header('cache-control', 'no-store').send({
      backups: backups.map((b) => ({
        filename:  b.filename,
        createdAt: b.createdAt.toISOString(),
        bytes:     b.bytes,
        rows:      b.rows,
        origin:    b.origin,
      })),
    });
  });

  // The download. This is the endpoint the whole redesign exists for: without it a scheduled backup
  // could only be retrieved by someone with access to the server, which on a hosted deployment is
  // nobody at all.
  fastify.get<{ Params: { filename: string } }>(
    '/admin/backup/archive/:filename',
    adminOwnerGuard,
    async (request, reply) => {
      const { filename } = request.params;

      // Checked against the exact shape the gateway itself produces, before any lookup. The record
      // is fetched by unique name so there is no path to traverse, but a name that cannot be one of
      // ours is a question worth refusing rather than answering with 404 after a database round
      // trip — and it keeps anything strange out of the Content-Disposition header below.
      if (!isBackupFilename(filename)) {
        return reply.code(400).send({ error: 'That is not a backup name.' });
      }

      const backup = await findStoredBackup(filename);
      if (!backup) return reply.code(404).send({ error: 'No backup by that name.' });

      recordAudit({
        action: 'backup.archive.download', method: 'GET', ...actor(request), status: 200,
        detail: JSON.stringify({ filename, bytes: backup.bytes }),
      });

      // Streamed from the chunk rows rather than assembled — a gigabyte backup must not become a
      // gigabyte of resident memory because somebody pressed download.
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('content-length', String(backup.bytes))
        .header('cache-control', 'no-store')
        .send(readStoredBackup(backup.id));
    },
  );

  // Deleting one by hand. Rate-limited with the auth bucket like every other destructive action
  // here: this is the only route that can remove a backup an operator is relying on.
  fastify.delete<{ Params: { filename: string } }>(
    '/admin/backup/archive/:filename',
    withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT),
    async (request, reply) => {
      const { filename } = request.params;
      if (!isBackupFilename(filename)) {
        return reply.code(400).send({ error: 'That is not a backup name.' });
      }

      const backup = await findStoredBackup(filename);
      if (!backup) return reply.code(404).send({ error: 'No backup by that name.' });

      await deleteStoredBackup(filename);
      recordAudit({
        action: 'backup.archive.delete', method: 'DELETE', ...actor(request), status: 200,
        detail: JSON.stringify({ filename, bytes: backup.bytes }),
      });
      return reply.send({ deleted: filename });
    },
  );
}
