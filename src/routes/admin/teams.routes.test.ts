/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Teams, budgets and the access keys they issue, driven through a real Fastify.
//
// ── The gap this closes ───────────────────────────────────────────────────────────────────────
//
// No HTTP-layer test existed for this file, and two of the things it decides are not the kind that
// fail loudly:
//
//   A team's `status` is what suspension means. A dependency bump made `.partial()` keep schema
//   defaults, so renaming a suspended team would have written status:'active' back over it —
//   answering 200, and putting a team you had cut off back to work spending money.
//
//   `GET /admin/team-keys/:id/reveal` hands back a LIVE credential in plaintext. It is a GET, so
//   the natural guard to reach for is the read guard, and the file carries a comment explaining
//   why it must be the write guard instead. Nothing checked that the comment matched the code.
//
// Prisma is stubbed: what is under test is the HTTP layer above it — which fields reach the
// database, who is refused, and what comes back. Only the authentication half of the guard is
// stubbed, so the real role check runs; the wiring is the point.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';

/** Who is knocking. Null means unauthenticated, which the auth middleware refuses. */
let role: string | null = 'owner';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    if (role === null) return reply.code(401).send({ error: 'Not signed in.' });
    (request as FastifyRequest & { adminRole?: string }).adminRole = role;
  },
}));

const db = vi.hoisted(() => ({
  teamFindMany:   vi.fn(),
  teamFindUnique: vi.fn(),
  teamCreate:     vi.fn(),
  teamUpdate:     vi.fn(),
  teamDelete:     vi.fn(),
  keyCount:       vi.fn(),
  tkFindMany:     vi.fn(),
  tkFindUnique:   vi.fn(),
  tkCreate:       vi.fn(),
  tkUpdate:       vi.fn(),
  tkDelete:       vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  dbEngine: 'postgres',
  prisma: {
    team: {
      findMany: db.teamFindMany, findUnique: db.teamFindUnique,
      create: db.teamCreate, update: db.teamUpdate, delete: db.teamDelete,
    },
    nexusKey:     { count: db.keyCount },
    nexusTeamKey: {
      findMany: db.tkFindMany, findUnique: db.tkFindUnique,
      create: db.tkCreate, update: db.tkUpdate, delete: db.tkDelete,
    },
  },
}));

const svc = vi.hoisted(() => ({ getCurrentSpend: vi.fn(), getTeamStats: vi.fn() }));
vi.mock('../../services/budget.service',    () => ({ getCurrentSpend: svc.getCurrentSpend }));
vi.mock('../../services/teamStats.service', () => ({ getTeamStats: svc.getTeamStats }));
vi.mock('../../lib/encryption', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

import adminTeamsRoutes from './teams.routes';

const SUSPENDED = {
  id: 't1', name: 'Contractors', status: 'suspended', assignedTier: 'fast',
  budgetUsd: 50, budgetPeriod: 'weekly', overBudgetAction: 'notify',
  byokFallback: false, createdAt: new Date('2026-01-01'), _count: { teamKeys: 2 },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminTeamsRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  db.teamFindMany.mockResolvedValue([SUSPENDED]);
  db.teamFindUnique.mockResolvedValue({ id: 't1' });
  db.teamCreate.mockImplementation(async ({ data }) => data);
  db.teamUpdate.mockImplementation(async ({ data }) => data);
  db.teamDelete.mockResolvedValue(undefined);
  db.keyCount.mockResolvedValue(0);
  db.tkFindMany.mockResolvedValue([]);
  db.tkFindUnique.mockResolvedValue({ id: 'k1', name: 'ci', encryptedKey: 'enc:nx_live_secret' });
  db.tkCreate.mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date('2026-01-01') }));
  db.tkUpdate.mockImplementation(async ({ data }) => ({ id: 'k1', name: 'ci', ...data }));
  db.tkDelete.mockResolvedValue(undefined);
  svc.getCurrentSpend.mockResolvedValue(12.5);
});

/** The data object the route handed Prisma on the single call it made. */
const dataOf = (m: { mock: { calls: unknown[][] } }) =>
  (m.mock.calls[0][0] as { data: Record<string, unknown> }).data;

// ── What a PATCH may write ────────────────────────────────────────────────────

describe('editing a team writes only what was sent', () => {
  it('does not un-suspend a team that was merely renamed', async () => {
    // THE regression, at the layer it would actually have happened. `.partial()` under zod 4
    // returns status:'active' here, and the route forwards the parsed body straight to
    // prisma.update — so a rename silently puts a suspended team back to work.
    const res = await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: { name: 'Renamed' } });

    expect(res.statusCode).toBe(200);
    expect(dataOf(db.teamUpdate)).toEqual({ name: 'Renamed' });
  });

  it('does not re-enable shared-pool fallback on a BYOK-isolated team', async () => {
    // byokFallback defaults to true. A team deliberately confined to its own keys would have been
    // let back onto the shared pool by any unrelated edit — spending the operator's credits under
    // the team's name, with nothing in the response to say so.
    await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: { assignedTier: 'premium' } });
    expect('byokFallback' in dataOf(db.teamUpdate)).toBe(false);
  });

  it('does not reset the budget period or the over-budget action', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: { budgetUsd: 100 } });
    const data = dataOf(db.teamUpdate);
    expect(data).toEqual({ budgetUsd: 100 });
    expect(data.budgetPeriod).toBeUndefined();
    expect(data.overBudgetAction).toBeUndefined();
  });

  it('writes nothing at all for an empty body', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: {} });
    expect(dataOf(db.teamUpdate)).toEqual({});
  });

  it('still suspends a team when that is what was asked', async () => {
    // Stripping the default must not make the field unsettable — this is the request an operator
    // makes to cut a team off.
    await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: { status: 'suspended' } });
    expect(dataOf(db.teamUpdate)).toEqual({ status: 'suspended' });
  });

  it('refuses a status the schema does not know, and writes nothing', async () => {
    // This asserted `>= 400` when it was written, because the route let the ZodError escape
    // `.parse()` and Fastify answered 500. Now pinned. The full contract for a malformed body
    // lives in malformedBody.test.ts; what belongs here is that nothing is written.
    const res = await app.inject({ method: 'PATCH', url: '/admin/teams/t1', payload: { status: 'deleted' } });
    expect(res.statusCode).toBe(400);
    expect(db.teamUpdate).not.toHaveBeenCalled();
  });
});

// ── Creating a team ───────────────────────────────────────────────────────────

describe('creating a team', () => {
  it('fills in the defaults a create is entitled to', async () => {
    // The other half of the rule above: stripping defaults from a patch must not stop a create
    // applying them, or a new team would arrive with no status and no budget period.
    const res = await app.inject({ method: 'POST', url: '/admin/teams', payload: { name: 'Growth' } });

    expect(res.statusCode).toBe(201);
    expect(dataOf(db.teamCreate)).toMatchObject({
      name: 'Growth', status: 'active', budgetPeriod: 'monthly',
      overBudgetAction: 'block', byokFallback: true,
    });
  });

  it('refuses a nameless team', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/teams', payload: { name: '' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(db.teamCreate).not.toHaveBeenCalled();
  });

  it('refuses a negative budget', async () => {
    // `positive()`, not `min(0)`: a negative cap would compare as "never reached" and the team
    // would spend without limit.
    const res = await app.inject({ method: 'POST', url: '/admin/teams', payload: { name: 'X', budgetUsd: -5 } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(db.teamCreate).not.toHaveBeenCalled();
  });
});

// ── Reading the list ──────────────────────────────────────────────────────────

describe('the team list', () => {
  it('round-trips byokFallback', async () => {
    // The edit modal seeds its draft from this row. A field missing here once made every edit
    // silently re-enable shared-pool fallback on a BYOK-isolated team — the same harm as the
    // PATCH bug above, arriving from the other direction.
    const res = await app.inject({ method: 'GET', url: '/admin/teams' });

    expect(res.statusCode).toBe(200);
    expect(res.json().teams[0]).toMatchObject({ byokFallback: false, overBudgetAction: 'notify' });
  });

  it('reports current spend against the team\'s own period, not a fixed one', async () => {
    await app.inject({ method: 'GET', url: '/admin/teams' });
    expect(svc.getCurrentSpend).toHaveBeenCalledWith('t1', 'weekly');
  });

  it('answers 404 for stats on a team that does not exist', async () => {
    svc.getTeamStats.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/admin/teams/nope/stats' })).statusCode).toBe(404);
  });

  it('falls back to a known window rather than passing an arbitrary period through', async () => {
    svc.getTeamStats.mockResolvedValue({ ok: true });
    await app.inject({ method: 'GET', url: '/admin/teams/t1/stats?period=all-time' });
    expect(svc.getTeamStats).toHaveBeenCalledWith('t1', '7d');
  });
});

// ── Deleting a team ───────────────────────────────────────────────────────────

describe('deleting a team', () => {
  it('reports how many of its own provider keys went with it', async () => {
    // Access keys survive their team; the team's OWN provider keys are destroyed with it, because
    // a private credential must never fall back into the shared pool. The count is what lets the
    // dashboard warn honestly before the click.
    db.keyCount.mockResolvedValue(3);
    const res = await app.inject({ method: 'DELETE', url: '/admin/teams/t1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, deletedOwnedKeys: 3 });
  });

  it('counts before it deletes, because afterwards there is nothing to count', async () => {
    await app.inject({ method: 'DELETE', url: '/admin/teams/t1' });
    expect(db.keyCount.mock.invocationCallOrder[0]).toBeLessThan(db.teamDelete.mock.invocationCallOrder[0]);
  });
});

// ── Team keys ─────────────────────────────────────────────────────────────────

describe('issuing an access key', () => {
  it('returns the plaintext once, and stores only a hash and a mask', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/team-keys', payload: { name: 'ci' } });

    expect(res.statusCode).toBe(201);
    const plain = res.json().key.plainKey as string;
    expect(plain).toMatch(/^nx_[0-9a-f]{48}$/);

    const stored = dataOf(db.tkCreate);
    // The plaintext must not be a column. It is returned once, encrypted for reveal, and hashed
    // for lookup — three different things, and a row that held the raw key would make the other
    // two pointless.
    expect(Object.values(stored)).not.toContain(plain);
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.maskedKey).toBe(`${plain.slice(0, 6)}••••••••${plain.slice(-4)}`);
  });

  it('refuses a key for a team that does not exist', async () => {
    // Without this the key is created attached to nothing, spends from no budget, and appears in
    // no team's usage.
    db.teamFindUnique.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/admin/team-keys', payload: { name: 'ci', teamId: 'ghost' } });

    expect(res.statusCode).toBe(400);
    expect(db.tkCreate).not.toHaveBeenCalled();
  });

  it('refuses a nameless key', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/team-keys', payload: { name: '  ' } })).statusCode).toBe(400);
  });

  it('never lists the plaintext or the hash', async () => {
    db.tkFindMany.mockResolvedValue([{
      id: 'k1', name: 'ci', maskedKey: 'nx_abc••••••••7f21',
      encryptedKey: 'enc:nx_live_secret', keyHash: 'a'.repeat(64),
      team: { id: 't1', name: 'Contractors' }, createdAt: new Date('2026-01-01'),
    }]);
    const body = (await app.inject({ method: 'GET', url: '/admin/team-keys' })).body;

    expect(body).not.toContain('nx_live_secret');
    expect(body).not.toContain('a'.repeat(64));
    expect(body).toContain('nx_abc••••••••7f21');
  });
});

describe('revealing an access key', () => {
  it('decrypts it for an owner', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/team-keys/k1/reveal' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: 'nx_live_secret' });
  });

  it('refuses a viewer, even though it is a GET', async () => {
    // The one place in this file where "it is a read, so use the read guard" is wrong. This hands
    // back a working credential: a viewer who can copy it is not read-only in any sense that
    // matters, because the key spends money the moment it is used.
    role = 'viewer';
    const res = await app.inject({ method: 'GET', url: '/admin/team-keys/k1/reveal' });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('nx_live_secret');
  });

  it('refuses a viewer before the row is even read', async () => {
    role = 'viewer';
    await app.inject({ method: 'GET', url: '/admin/team-keys/k1/reveal' });
    expect(db.tkFindUnique).not.toHaveBeenCalled();
  });

  it('answers 404 for a key that does not exist', async () => {
    db.tkFindUnique.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/admin/team-keys/k1/reveal' })).statusCode).toBe(404);
  });
});

// ── Who may do any of this ────────────────────────────────────────────────────

describe('teams and their keys are not a viewer\'s to change', () => {
  const MUTATIONS = [
    { method: 'POST'   as const, url: '/admin/teams',        payload: { name: 'X' },  what: 'creating a team' },
    { method: 'PATCH'  as const, url: '/admin/teams/t1',     payload: { name: 'X' },  what: 'editing a team' },
    { method: 'DELETE' as const, url: '/admin/teams/t1',     payload: undefined,      what: 'deleting a team' },
    { method: 'POST'   as const, url: '/admin/team-keys',    payload: { name: 'ci' }, what: 'issuing a key' },
    { method: 'PATCH'  as const, url: '/admin/team-keys/k1', payload: { teamId: null }, what: 'reassigning a key' },
    { method: 'DELETE' as const, url: '/admin/team-keys/k1', payload: undefined,      what: 'revoking a key' },
    { method: 'GET'    as const, url: '/admin/team-keys/k1/reveal', payload: undefined, what: 'revealing a key' },
  ];

  it.each(MUTATIONS)('refuses an unauthenticated caller $what', async ({ method, url, payload }) => {
    role = null;
    expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
  });

  it.each(MUTATIONS)('refuses a viewer $what', async ({ method, url, payload }) => {
    role = 'viewer';
    expect((await app.inject({ method, url, payload })).statusCode).toBe(403);
  });

  it.each([
    { url: '/admin/teams',     what: 'the team list' },
    { url: '/admin/team-keys', what: 'the masked key list' },
  ])('lets a viewer read $what', async ({ url }) => {
    role = 'viewer';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('lets an admin run the day to day', async () => {
    role = 'admin';
    expect((await app.inject({ method: 'POST', url: '/admin/teams', payload: { name: 'Growth' } })).statusCode).toBe(201);
  });
});
