/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The stored-backup archive, driven through a real Fastify.
//
// ── The gap this closes ───────────────────────────────────────────────────────────────────────
//
// A stored backup is every provider key, every team key and every TOTP secret in one file. The
// download is the same disclosure as `/admin/backup/export`, and the e2e suite proves a viewer
// credential is refused THERE (07-backup.spec.ts). Nothing proved it here. Same data, same
// sensitivity, one route checked and one not — and the unchecked one is the newer of the two, which
// is the wrong way round.
//
// `requireOwner` itself is already covered by guard.test.ts, so re-testing the role logic would
// prove nothing. What was never checked is the WIRING: that these three routes are attached to
// `adminOwnerGuard` rather than to `adminGuard`, which is a one-word difference that no type would
// catch and that would hand every read-only account the gateway's entire credential store. So the
// real guard runs here; only the authentication half is stubbed, to choose who is knocking.
//
// The store is stubbed too — `backupStore.test.ts` already drives it against a fake database, and
// what is under test here is the HTTP layer above it: the guard, the filename refusal, the headers
// that stop a proxy caching a credential file, and the audit trail.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { Readable } from 'node:stream';

/** Who is knocking. Null means an unauthenticated caller, which the auth middleware refuses. */
let role: string | null = 'owner';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    if (role === null) return reply.code(401).send({ error: 'Not signed in.' });
    (request as FastifyRequest & { adminRole?: string }).adminRole = role;
  },
}));

const store = vi.hoisted(() => ({
  listStoredBackups: vi.fn(),
  findStoredBackup: vi.fn(),
  deleteStoredBackup: vi.fn(),
  readStoredBackup: vi.fn(),
}));
vi.mock('../../lib/backup/backupStore', () => store);

const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock('../../services/audit.service', () => ({ recordAudit }));

// backup.routes pulls in the export engine, prisma and redis for the sake of one four-line helper.
// Reproduced rather than imported so this file stays a unit test; `actor` is not what is under test
// here, but the audit assertions below still read a real role off the request.
vi.mock('./backup.routes', () => ({
  actor: (request: FastifyRequest) => ({
    actorRole: (request as FastifyRequest & { adminRole?: string }).adminRole ?? 'system',
    actorId: null, actorName: null, ip: request.ip,
  }),
}));

import adminBackupArchiveRoutes from './backupArchive.routes';

const FILENAME = 'alayra-nexus-backup-2026-05-06-03-00-00.nxb';
const CONTENTS = Buffer.from([0x7b, 0x22, 0x66, 0x00, 0xff, 0x0a, 0x53, 0x45, 0x41, 0x4c]);

const BACKUP = {
  id: 'bk-1', filename: FILENAME, createdAt: new Date('2026-05-06T03:00:00.000Z'),
  bytes: CONTENTS.length, rows: 1200, origin: 'scheduled',
};

/**
 * One app for the whole file, built once.
 *
 * Not an optimisation. Building a Fastify instance compiles a router and a serializer, and the
 * FIRST one in a cold module cache took over five seconds on a loaded machine here — failing a test
 * that asserts a status code, on a duration it does not measure. That is the same shape as the
 * repository's existing flaky bare-Fastify test, and raising the timeout would have hidden it
 * rather than removed it. Nothing here is stateful between requests: who is knocking is read off
 * `role` when the request arrives, not when the app was built.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminBackupArchiveRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  store.listStoredBackups.mockResolvedValue([BACKUP]);
  store.findStoredBackup.mockResolvedValue(BACKUP);
  store.deleteStoredBackup.mockResolvedValue(undefined);
  store.readStoredBackup.mockReturnValue(Readable.from([CONTENTS]));
});

/** The three endpoints, as a table — every access check below runs against all of them. */
const ROUTES = [
  { method: 'GET' as const,    url: '/admin/backup/archive',              what: 'the list' },
  { method: 'GET' as const,    url: `/admin/backup/archive/${FILENAME}`,  what: 'a download' },
  { method: 'DELETE' as const, url: `/admin/backup/archive/${FILENAME}`,  what: 'a deletion' },
];

// ── Who may reach the archive at all ──────────────────────────────────────────

describe('the archive is owner-only, on every endpoint', () => {
  it.each(ROUTES)('refuses an unauthenticated caller $what', async ({ method, url }) => {
    role = null;

    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)('refuses a viewer $what', async ({ method, url }) => {
    // The check `/admin/backup/export` has had since B1 and this route has never had. A viewer is
    // the least credential the gateway issues; it must not extend to walking out with every secret
    // in the deployment.
    role = 'viewer';

    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(403);
  });

  it.each(ROUTES)('refuses an admin $what — an admin is not an owner', async ({ method, url }) => {
    role = 'admin';

    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(403);
  });

  it('refuses before the store is touched at all', async () => {
    role = 'viewer';

    await app.inject({ method: 'GET', url: `/admin/backup/archive/${FILENAME}` });
    await app.inject({ method: 'DELETE', url: `/admin/backup/archive/${FILENAME}` });

    // The guard is a preHandler, so a refusal must happen before any handler work. A 403 that had
    // already read the record would still be a 403 — and would still have loaded a credential file's
    // metadata for someone not allowed to see it.
    expect(store.findStoredBackup).not.toHaveBeenCalled();
    expect(store.deleteStoredBackup).not.toHaveBeenCalled();
  });
});

// ── The list ──────────────────────────────────────────────────────────────────

describe('listing what the gateway has kept', () => {
  it('answers with the backups, and forbids caching them', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/backup/archive' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backups: [{
        filename: FILENAME, createdAt: '2026-05-06T03:00:00.000Z',
        bytes: CONTENTS.length, rows: 1200, origin: 'scheduled',
      }],
    });

    // Even the list is `no-store`: it names every backup and when it was taken, which is a map of
    // what to steal and when nobody was looking.
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

// ── The download ──────────────────────────────────────────────────────────────

describe('downloading one', () => {
  it('hands back exactly the stored bytes, with headers that stop a proxy keeping them', async () => {
    const res = await app.inject({ method: 'GET', url: `/admin/backup/archive/${FILENAME}` });

    expect(res.statusCode).toBe(200);
    // Compared as bytes. This is the file an operator restores from, and text handling anywhere on
    // the way out would leave it the right length and unopenable.
    expect(res.rawPayload).toEqual(CONTENTS);

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${FILENAME}"`);
    expect(res.headers['content-length']).toBe(String(CONTENTS.length));
    // Not politeness: without it a shared proxy is entitled to keep the gateway's credentials.
    expect(res.headers['cache-control']).toContain('no-store');

    // Streamed from the chunk rows rather than assembled, so a gigabyte backup is not a gigabyte of
    // resident memory. Passing the id — never the operator's string — is what makes that safe.
    expect(store.readStoredBackup).toHaveBeenCalledWith('bk-1');
  });

  it.each([
    ['notes.txt',                          'a name that is not one of ours'],
    ['%2e%2e%2f%2e%2e%2fetc%2fpasswd',     'an encoded attempt to leave the archive'],
    ['alayra-nexus-backup-2026-05-06.nxb', 'a name that is nearly right'],
  ])('refuses %s (%s) before any lookup', async (filename) => {
    const res = await app.inject({ method: 'GET', url: `/admin/backup/archive/${filename}` });

    expect(res.statusCode).toBe(400);
    // Checked against the exact shape the gateway itself produces, and checked FIRST. The record is
    // fetched by unique name so there is no path to traverse either way, but nothing strange should
    // reach the database or the Content-Disposition header to begin with.
    expect(store.findStoredBackup).not.toHaveBeenCalled();
  });

  it('answers 404 for a well-formed name it does not have', async () => {
    store.findStoredBackup.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: `/admin/backup/archive/${FILENAME}` });
    expect(res.statusCode).toBe(404);
    expect(store.readStoredBackup).not.toHaveBeenCalled();
  });
});

// ── Deleting one ──────────────────────────────────────────────────────────────

describe('deleting one by hand', () => {
  it('removes it and names what went', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/admin/backup/archive/${FILENAME}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: FILENAME });
    expect(store.deleteStoredBackup).toHaveBeenCalledWith(FILENAME);
  });

  it('deletes nothing when the name is unknown', async () => {
    store.findStoredBackup.mockResolvedValue(null);

    const res = await app.inject({ method: 'DELETE', url: `/admin/backup/archive/${FILENAME}` });
    expect(res.statusCode).toBe(404);
    // The lookup happens first precisely so this is a 404 and not a silent success against nothing.
    expect(store.deleteStoredBackup).not.toHaveBeenCalled();
  });

  it('refuses a name that is not one of ours without touching the store', async () => {

    const res = await app.inject({ method: 'DELETE', url: '/admin/backup/archive/notes.txt' });
    expect(res.statusCode).toBe(400);
    // The one route here that destroys. `isBackupFilename` is what keeps it from being pointed at
    // anything the gateway did not write.
    expect(store.deleteStoredBackup).not.toHaveBeenCalled();
  });
});

// ── The trail ─────────────────────────────────────────────────────────────────

describe('what the audit trail is told', () => {
  it('records who downloaded a copy of every credential, and which one', async () => {
    await app.inject({ method: 'GET', url: `/admin/backup/archive/${FILENAME}` });

    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls[0][0] as { action: string; actorRole: string; detail: string };
    expect(entry.action).toBe('backup.archive.download');
    expect(entry.actorRole).toBe('owner');
    // "Who took a copy of every secret in this deployment, and when" must have an answer.
    expect(JSON.parse(entry.detail)).toEqual({ filename: FILENAME, bytes: CONTENTS.length });
  });

  it('records a deletion, including how big the thing removed was', async () => {
    await app.inject({ method: 'DELETE', url: `/admin/backup/archive/${FILENAME}` });

    const entry = recordAudit.mock.calls[0][0] as { action: string; detail: string };
    expect(entry.action).toBe('backup.archive.delete');
    // Recorded from the record read BEFORE the delete — afterwards there is nothing left to measure,
    // and a trail that cannot say what was destroyed is not much of a trail.
    expect(JSON.parse(entry.detail)).toEqual({ filename: FILENAME, bytes: CONTENTS.length });
  });

  it('records nothing when a caller was refused', async () => {
    role = 'viewer';
    await app.inject({ method: 'GET', url: `/admin/backup/archive/${FILENAME}` });

    // The route's own detailed record is not written for a request that never reached the handler.
    // The coarse per-response row that routes/admin/index.ts writes for EVERY request is what
    // carries the refusal, and it is not registered in this bare app.
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
