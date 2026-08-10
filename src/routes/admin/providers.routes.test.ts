/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Provider pools, driven through a real Fastify.
//
// ── The gap this closes ───────────────────────────────────────────────────────────────────────
//
// This file had no HTTP-layer test at all, and that absence is not theoretical: a dependency bump
// changed `.partial()` so that a PATCH carried every schema default, which would have reset a
// pool's `authHeader` from `x-api-key` back to `Authorization` on any edit — silently breaking
// authentication for every Anthropic pool. Typecheck passed, lint passed, 1,782 tests passed. The
// only thing that could have caught it is a request going in and the row that comes out being
// checked, which is what this file does.
//
// ── What is stubbed, and why ──────────────────────────────────────────────────────────────────
//
// Prisma, because what is under test is the HTTP layer above it: which fields reach the database,
// which callers are refused, and what the route does with the answer. The SSRF *policy* lookup is
// stubbed (it reads settings) but `assertSafeUrl` itself is the real one — a route test that
// mocked the URL check would prove nothing about the route that calls it.
//
// Only the authentication half of the guard is stubbed, so the real `requireWrite` runs. The
// wiring is the point: `adminGuard` where `adminWriteGuard` was meant is a one-word difference no
// type catches, and it hands every read-only account the ability to repoint a pool at a host of
// their choosing.

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
  findMany:   vi.fn(),
  findUnique: vi.fn(),
  create:     vi.fn(),
  update:     vi.fn(),
  del:        vi.fn(),
  count:      vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  dbEngine: 'postgres',
  prisma: {
    nexusProvider: {
      findMany:   db.findMany,
      findUnique: db.findUnique,
      create:     db.create,
      update:     db.update,
      delete:     db.del,
      count:      db.count,
    },
  },
}));

const svc = vi.hoisted(() => ({
  validateProviderCredentials: vi.fn(),
  validateModel:               vi.fn(),
  fetchProviderModels:         vi.fn(),
  removeModelsForProvider:     vi.fn(),
  invalidateProviderCache:     vi.fn(),
  getSsrfPolicy:               vi.fn(),
}));
vi.mock('../../services/nexus.service', () => ({
  validateProviderCredentials: svc.validateProviderCredentials,
  validateModel:               svc.validateModel,
  fetchProviderModels:         svc.fetchProviderModels,
}));
vi.mock('../../services/model.service',         () => ({ removeModelsForProvider: svc.removeModelsForProvider }));
vi.mock('../../services/providerCache.service', () => ({ invalidateProviderCache: svc.invalidateProviderCache }));
vi.mock('../../services/ssrf.service',          () => ({ getSsrfPolicy: svc.getSsrfPolicy }));

import adminProvidersRoutes from './providers.routes';

/** A complete, valid pool body — every test starts from this and changes one thing. */
const VALID = {
  name: 'Anthropic prod', slug: 'anthropic-prod', provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  authHeader: 'x-api-key', authPrefix: '',
  modelIdPath: 'data[].id', tier: 'premium' as const,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminProvidersRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);          // no slug conflict by default
  db.create.mockImplementation(async ({ data }) => data);
  db.update.mockImplementation(async ({ data }) => data);
  db.del.mockResolvedValue(undefined);
  db.count.mockResolvedValue(0);
  // The real shape from lib/url.ts — `allowList` is a Set, and getting that wrong makes
  // assertSafeUrl throw on every URL, which reads as "the route blocks everything".
  svc.getSsrfPolicy.mockResolvedValue({ allowPrivate: false, allowList: new Set<string>() });
  svc.invalidateProviderCache.mockResolvedValue(undefined);
});

/** The data object the route handed Prisma on the single call it made. */
const dataOf = (m: { mock: { calls: unknown[][] } }) =>
  (m.mock.calls[0][0] as { data: Record<string, unknown> }).data;

// ── Who may change a pool ─────────────────────────────────────────────────────

describe('changing a pool takes more than a viewer', () => {
  const MUTATIONS = [
    { method: 'POST'   as const, url: '/admin/providers',              payload: VALID, what: 'creating one' },
    { method: 'PATCH'  as const, url: '/admin/providers/p1',           payload: { name: 'x' }, what: 'editing one' },
    { method: 'DELETE' as const, url: '/admin/providers/p1',           payload: undefined, what: 'deleting one' },
    { method: 'POST'   as const, url: '/admin/validate/provider',      payload: { provider: 'groq', apiKey: 'k' }, what: 'probing a credential' },
    { method: 'POST'   as const, url: '/admin/providers/p1/fetch-models', payload: {}, what: 'fetching models' },
  ];

  it.each(MUTATIONS)('refuses an unauthenticated caller $what', async ({ method, url, payload }) => {
    role = null;
    expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
  });

  it.each(MUTATIONS)('refuses a viewer $what', async ({ method, url, payload }) => {
    // A viewer who can repoint a pool's baseUrl can route every request through a host they chose,
    // with the operator's keys attached. Read-only has to mean it.
    role = 'viewer';
    expect((await app.inject({ method, url, payload })).statusCode).toBe(403);
  });

  it('refuses a viewer before Prisma is touched at all', async () => {
    role = 'viewer';
    await app.inject({ method: 'DELETE', url: '/admin/providers/p1' });
    expect(db.del).not.toHaveBeenCalled();
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it('lets a viewer read the list', async () => {
    role = 'viewer';
    expect((await app.inject({ method: 'GET', url: '/admin/providers' })).statusCode).toBe(200);
  });

  it('lets an admin create one — this is day-to-day operation, not ownership', async () => {
    role = 'admin';
    expect((await app.inject({ method: 'POST', url: '/admin/providers', payload: VALID })).statusCode).toBe(201);
  });
});

// ── What a PATCH may write ────────────────────────────────────────────────────

describe('editing a pool writes only what was sent', () => {
  it('does not reset authHeader when only the name changed', async () => {
    // THE regression. zod 4 made `.partial()` keep `.default()`, so this PATCH carried
    // authHeader:'Authorization', modelIdPath:'data[].id' and tier:'standard' — writing all three
    // over an Anthropic pool that needs x-api-key, and answering 200 while doing it.
    const res = await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { name: 'Renamed' } });

    expect(res.statusCode).toBe(200);
    expect(dataOf(db.update)).toEqual({ name: 'Renamed' });
  });

  it('writes nothing at all for an empty body', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: {} });
    expect(dataOf(db.update)).toEqual({});
  });

  it('still writes a default-bearing field when the caller names it', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { authHeader: 'Authorization' } });
    expect(dataOf(db.update)).toEqual({ authHeader: 'Authorization' });
  });

  it('still validates what it is given', async () => {
    // This asserted `>= 400` when it was written: the route called `schema.parse()`, let the
    // ZodError escape, and Fastify answered 500 — a client's bad body reported as a server fault.
    // Now pinned, along with the other ten call sites that shared the defect. The full contract
    // for a malformed body — the shape, the fields it names, and that no credential comes back —
    // is in malformedBody.test.ts; what belongs here is that the row is not written.
    const res = await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { tier: 'platinum' } });
    expect(res.statusCode).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('invalidates the routing cache after a successful edit', async () => {
    // The cache holds pool rows. An edit that does not bust it is an edit that takes effect at some
    // unpredictable later moment, which is worse than one that does not take effect at all.
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { name: 'Renamed' } });
    expect(svc.invalidateProviderCache).toHaveBeenCalledOnce();
  });
});

// ── Creating a pool ───────────────────────────────────────────────────────────

describe('creating a pool', () => {
  it('fills in the schema defaults that a create is entitled to', async () => {
    const { tier: _tier, modelIdPath: _path, ...withoutDefaults } = VALID;
    const res = await app.inject({ method: 'POST', url: '/admin/providers', payload: withoutDefaults });

    expect(res.statusCode).toBe(201);
    // The other half of the PATCH rule: stripping defaults from a patch must not stop a create
    // filling them in.
    expect(dataOf(db.create)).toMatchObject({ tier: 'standard', modelIdPath: 'data[].id' });
  });

  it('refuses a duplicate slug with a 409 rather than a database error', async () => {
    db.findUnique.mockResolvedValue({ id: 'existing' });
    const res = await app.inject({ method: 'POST', url: '/admin/providers', payload: VALID });

    expect(res.statusCode).toBe(409);
    expect(db.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an uppercase slug', 'Anthropic-Prod'],
    ['a slug with spaces', 'anthropic prod'],
    ['an empty slug', ''],
  ])('refuses %s', async (_label, slug) => {
    // The slug reaches URLs and error strings, which is the whole reason its shape is checked even
    // though the column is free text. Status not pinned — see the note on validation above.
    const res = await app.inject({ method: 'POST', url: '/admin/providers', payload: { ...VALID, slug } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(db.create).not.toHaveBeenCalled();
  });

  it('accepts a provider slug that is not one of the shipped presets', async () => {
    // Presets are defaults, not a whitelist — this is the enum removal, asserted at the HTTP layer
    // where the old 400 actually came from.
    const res = await app.inject({
      method: 'POST', url: '/admin/providers',
      payload: { ...VALID, slug: 'acme-llm', provider: 'acme-internal-llm' },
    });
    expect(res.statusCode).toBe(201);
    expect(dataOf(db.create)).toMatchObject({ provider: 'acme-internal-llm' });
  });
});

// ── extraHeaders, which is stored as a string ─────────────────────────────────

describe('extra headers', () => {
  it('serialises an object to the JSON string the column holds', async () => {
    await app.inject({
      method: 'POST', url: '/admin/providers',
      payload: { ...VALID, extraHeaders: { 'anthropic-version': '2023-06-01' } },
    });
    expect(dataOf(db.create).extraHeaders).toBe('{"anthropic-version":"2023-06-01"}');
  });

  it('reads an empty object as "clear them", not as an empty object', async () => {
    // `{}` and `null` mean different things here and the difference is invisible in the response:
    // storing "{}" would send a header block the provider never asked for.
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { extraHeaders: {} } });
    expect(dataOf(db.update).extraHeaders).toBeNull();
  });

  it('leaves the column alone when the caller does not mention it', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { name: 'Renamed' } });
    expect('extraHeaders' in dataOf(db.update)).toBe(false);
  });
});

// ── SSRF ──────────────────────────────────────────────────────────────────────

describe('a pool may not be pointed at an internal host', () => {
  it.each([
    ['creating', 'POST'  as const, '/admin/providers'],
    ['editing',  'PATCH' as const, '/admin/providers/p1'],
  ])('refuses a loopback baseUrl when %s', async (_what, method, url) => {
    const res = await app.inject({ method, url, payload: { ...VALID, baseUrl: 'http://127.0.0.1:6379/v1' } });

    expect(res.statusCode).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('checks the model-fetch URL too, not only the base', async () => {
    // Two URLs are stored and both are fetched with the operator's key attached. Checking one is
    // the same as checking neither.
    const res = await app.inject({
      method: 'POST', url: '/admin/providers',
      payload: { ...VALID, modelFetchUrl: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(res.statusCode).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
  });

  it('allows a public URL', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/providers', payload: VALID })).statusCode).toBe(201);
  });
});

// ── Deleting a pool, and the models it leaves behind ──────────────────────────

describe('deleting a pool', () => {
  beforeEach(() => { db.findUnique.mockResolvedValue({ provider: 'anthropic' }); });

  it('clears the provider\'s models when that was the last pool for it', async () => {
    // The registry is keyed by provider slug with no foreign key, so without this the models stay
    // and reappear the moment a pool of the same provider is created again.
    db.count.mockResolvedValue(0);
    const res = await app.inject({ method: 'DELETE', url: '/admin/providers/p1' });

    expect(res.statusCode).toBe(200);
    expect(svc.removeModelsForProvider).toHaveBeenCalledWith('anthropic');
  });

  it('keeps them when a sibling pool of the same provider is still serving', async () => {
    // The opposite error, and the more damaging one: deleting a spare Anthropic pool would have
    // wiped the models the remaining pool routes to.
    db.count.mockResolvedValue(1);
    await app.inject({ method: 'DELETE', url: '/admin/providers/p1' });

    expect(svc.removeModelsForProvider).not.toHaveBeenCalled();
  });

  it('reads the row before deleting it, because afterwards the slug is unknowable', async () => {
    await app.inject({ method: 'DELETE', url: '/admin/providers/p1' });
    const readAt = db.findUnique.mock.invocationCallOrder[0];
    const delAt  = db.del.mock.invocationCallOrder[0];
    expect(readAt).toBeLessThan(delAt);
  });

  it('busts the routing cache', async () => {
    await app.inject({ method: 'DELETE', url: '/admin/providers/p1' });
    expect(svc.invalidateProviderCache).toHaveBeenCalledOnce();
  });
});

// ── The probes ────────────────────────────────────────────────────────────────

describe('the validation probes', () => {
  it('refuses a credential check with no key rather than probing with undefined', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/validate/provider', payload: { provider: 'groq' } });

    expect(res.statusCode).toBe(400);
    expect(svc.validateProviderCredentials).not.toHaveBeenCalled();
  });

  it('refuses a model check missing either half', async () => {
    for (const payload of [{ providerId: 'p1' }, { modelName: 'gpt-4o' }, {}]) {
      const res = await app.inject({ method: 'POST', url: '/admin/validate/model', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(svc.validateModel).not.toHaveBeenCalled();
  });

  it('reports a failed model fetch as a 400 with an empty list', async () => {
    // The dashboard reads `models` off this response. Answering 400 with the field absent turns a
    // readable "provider refused the key" into a client-side crash.
    svc.fetchProviderModels.mockResolvedValue({ ok: false, error: 'HTTP 401' });
    const res = await app.inject({ method: 'POST', url: '/admin/providers/p1/fetch-models', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'HTTP 401', models: [] });
  });

  it('passes a pre-save plaintext key through to the fetch', async () => {
    // The "Fetch Models" flow probes before the key is stored. If the key were dropped here the
    // fetch would fall back to an existing key, or to none, and quietly list the wrong catalogue.
    svc.fetchProviderModels.mockResolvedValue({ ok: true, models: [{ id: 'm1' }] });
    await app.inject({ method: 'POST', url: '/admin/providers/p1/fetch-models', payload: { plainKey: 'sk-test' } });

    expect(svc.fetchProviderModels).toHaveBeenCalledWith('p1', 'sk-test');
  });
});
