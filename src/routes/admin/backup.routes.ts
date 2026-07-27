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

// Backup and restore over HTTP (Phase B1.3).
//
// ── Who may do this, and why the two differ ───────────────────────────────────────────────────
//
// OWNER ONLY, both of them. An export is every provider key, every team key and every TOTP secret
// in one file; a restore rewrites the gateway. Those belong with the other things that decide who
// the gateway belongs to — people, invites, SSO, the reset — not with day-to-day administration.
//
// A `replace` restore additionally demands the MASTER PASSWORD and a TYPED PHRASE, exactly as the
// factory reset does, and for the same reason: it empties every table first. Three proofs of
// different kinds — an owner session (you run this gateway), the environment's password (you
// installed it), and the phrase (you meant to). `merge` asks for none of that, because it cannot
// destroy anything: it only inserts what is missing and never overwrites.
//
// ── Everything is audited, including the refusals ─────────────────────────────────────────────
//
// Especially the refusals. A wrong passphrase against an export is indistinguishable from someone
// probing, and the trail is the only place that would ever show up. Success is audited too — the
// question "who took a copy of every credential, and when" must have an answer.

import { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { adminOwnerGuard } from './guard';
import { AUTH_RATE_LIMIT, withRateLimit } from '../../lib/routeRateLimits';
import { safeEqual } from '../../lib/timingSafe';
import { recordAudit } from '../../services/audit.service';
import { exportBackup, restoreBackup, backupFilename } from '../../services/backup.service';
import { passphraseProblem } from '../../lib/backup/format';
import type { RestoreMode } from '../../lib/backup/restore';

/** Typed exactly as the factory reset's, so the two destructive actions feel the same. */
export const RESTORE_CONFIRM_PHRASE = 'REPLACE ALL DATA';

/**
 * How large an uploaded backup may be.
 *
 * The server's global multipart cap is 26 MB, sized for an audio file, and a gateway with real
 * usage history will exceed that easily — so this route raises its own limit rather than failing a
 * restore for a reason that has nothing to do with backups.
 */
const MAX_BACKUP_BYTES = parseInt(process.env.NEXUS_MAX_BACKUP_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);

/** The audit fields every entry here shares. */
function actor(request: FastifyRequest) {
  return {
    actorRole: request.adminRole ?? 'system',
    actorId:   request.adminUserId ?? null,
    actorName: request.adminUserName ?? null,
    ip:        request.ip,
  };
}

export default async function adminBackupRoutes(fastify: FastifyInstance) {
  // ── Export ────────────────────────────────────────────────────────
  //
  // POST rather than GET: the passphrase is in the body, and a GET would put it in the URL — where
  // it lands in access logs, proxy logs and browser history.
  fastify.post('/admin/backup/export', withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    const parsed = z.object({ passphrase: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A backup passphrase is required.' });

    const problem = passphraseProblem(parsed.data.passphrase);
    if (problem) return reply.code(400).send({ error: problem });

    const filename = backupFilename();

    // Headers before the first byte: once the body starts flowing, the status is already sent and
    // an error can no longer be reported as one.
    reply.raw.setHeader('content-type', 'application/octet-stream');
    reply.raw.setHeader('content-disposition', `attachment; filename="${filename}"`);
    // Never cached, never stored by an intermediary. This is the most sensitive response the
    // gateway can produce.
    reply.raw.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    reply.raw.setHeader('x-content-type-options', 'nosniff');

    try {
      const summary = await exportBackup(parsed.data.passphrase, reply.raw);
      recordAudit({
        action: 'backup.export', method: 'POST', ...actor(request), status: 200,
        detail: JSON.stringify({ filename, rows: summary.totalRows, secrets: summary.secrets }),
      });
      reply.raw.end();
    } catch (err) {
      // The body may already be part-written, so there is no status left to change. Recording it
      // and destroying the connection is the honest end: a truncated file will not authenticate,
      // so the operator cannot mistake it for a good backup.
      recordAudit({
        action: 'backup.export', method: 'POST', ...actor(request), status: 500,
        detail: JSON.stringify({ outcome: 'failed', error: (err as Error).message }),
      });
      reply.raw.destroy();
    }
    return reply;
  });

  // ── Restore ───────────────────────────────────────────────────────
  //
  // multipart/form-data: the file plus its passphrase, mode and confirmation. The upload is spooled
  // to a temporary file rather than held in memory — a backup is unbounded, and the point of the
  // streaming design would be lost by buffering it here. It is ciphertext on disk the whole time,
  // and removed in a `finally`.
  fastify.post('/admin/backup/restore', withRateLimit(adminOwnerGuard, AUTH_RATE_LIMIT), async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'Upload the backup as multipart/form-data with a "file" part.' });
    }

    const fields: Record<string, string> = {};
    let dir: string | null = null;
    let path: string | null = null;

    try {
      for await (const part of request.parts({ limits: { fileSize: MAX_BACKUP_BYTES } })) {
        if (part.type === 'file') {
          dir = await mkdtemp(join(tmpdir(), 'nexus-restore-'));
          path = join(dir, 'upload.nxb');
          await pipeline(part.file, createWriteStream(path));
          if (part.file.truncated) {
            return reply.code(413).send({ error: `That backup is larger than the ${MAX_BACKUP_BYTES} byte limit. Raise NEXUS_MAX_BACKUP_BYTES.` });
          }
          continue;
        }
        fields[part.fieldname] = String(part.value);
      }

      if (!path) return reply.code(400).send({ error: 'No backup file was uploaded.' });

      const parsed = z.object({
        passphrase: z.string(),
        mode: z.enum(['merge', 'replace']).default('merge'),
        dryRun: z.enum(['true', 'false']).default('false'),
        masterPassword: z.string().optional(),
        confirm: z.string().optional(),
      }).safeParse(fields);
      if (!parsed.success) return reply.code(400).send({ error: 'A backup passphrase is required.' });

      const { passphrase, masterPassword, confirm } = parsed.data;
      const mode = parsed.data.mode as RestoreMode;
      const dryRun = parsed.data.dryRun === 'true';

      const problem = passphraseProblem(passphrase);
      if (problem) return reply.code(400).send({ error: problem });

      // A dry run writes nothing, so it needs no extra proof — and demanding one would discourage
      // the very step that makes `replace` safe to offer at all.
      if (mode === 'replace' && !dryRun) {
        if (confirm !== RESTORE_CONFIRM_PHRASE) {
          return reply.code(400).send({ error: `Type the phrase exactly: ${RESTORE_CONFIRM_PHRASE}` });
        }
        if (!safeEqual(masterPassword ?? '', process.env.ADMIN_PASSWORD)) {
          recordAudit({
            action: 'backup.restore', method: 'POST', ...actor(request), status: 401,
            detail: JSON.stringify({ outcome: 'refused_master_password', mode }),
          });
          return reply.code(401).send({ error: 'That is not the administrator password from your server’s environment.' });
        }
      }

      try {
        const result = await restoreBackup({ input: createReadStream(path), passphrase, mode, dryRun });
        recordAudit({
          action: dryRun ? 'backup.restore.dryrun' : 'backup.restore', method: 'POST', ...actor(request), status: 200,
          detail: JSON.stringify({
            mode, rowsInFile: result.totalRowsInFile, written: result.totalWritten,
            secrets: result.secretsRekeyed, tablesCleared: result.tablesCleared,
            from: result.gatewayVersion, takenAt: result.createdAt,
          }),
        });
        return reply.send(result);
      } catch (err) {
        // A wrong passphrase and a damaged file are indistinguishable to us by design — GCM says
        // only "did not authenticate" — so the message names both rather than guessing.
        recordAudit({
          action: dryRun ? 'backup.restore.dryrun' : 'backup.restore', method: 'POST', ...actor(request), status: 400,
          detail: JSON.stringify({ outcome: 'failed', mode, error: (err as Error).message }),
        });
        return reply.code(400).send({
          error: (err as Error).message,
          hint: 'Nothing was changed. If the passphrase is right, the file may be damaged or incomplete.',
        });
      }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => { /* temp dir */ });
    }
  });
}
