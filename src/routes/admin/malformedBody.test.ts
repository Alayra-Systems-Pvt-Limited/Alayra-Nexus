/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── A malformed admin body is the caller's mistake, and is answered as one ─────────────────────
//
// Eleven routes across four files called `schema.parse(request.body)` and let the ZodError escape
// into Fastify, which answered 500. The consequences were not cosmetic:
//
//   • an operator's typo raised the gateway's server-error rate, and every dashboard, alert and
//     SLO built on 5xx counted it as an outage of ours
//   • a well-written client retries 5xx and does not retry 4xx, so a body that will never be
//     accepted was retried until something gave up
//   • what the operator saw was a serialised ZodError — zod's internals as a wall of JSON — with
//     nothing saying the fix was theirs
//
// This file is the cross-cutting contract rather than four separate suites, because the invariant
// is cross-cutting: it is a list of every route that validates a body, and it is only useful if it
// is complete. The drift guard at the bottom is what keeps it complete.
//
// What is stubbed: everything below the HTTP layer. None of it is reached — the point of the fix
// is that a bad body is refused before any service or query runs, and `expect(nothing happened)`
// is half of what each case asserts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join }                      from 'path';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';

/**
 * Who is knocking. Owner for the cases below, and varied by the last describe in this file —
 * because who may see a validation error is part of what a validation error is allowed to say.
 */
let role: string | null = 'owner';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    if (role === null) return reply.code(401).send({ error: 'Not signed in.' });
    (request as FastifyRequest & { adminRole?: string }).adminRole = role;
  },
}));

/** Every write these routes could perform. Each case asserts none of them fired. */
const writes = vi.hoisted(() => ({
  providerCreate: vi.fn(), providerUpdate: vi.fn(),
  teamCreate:     vi.fn(), teamUpdate:     vi.fn(),
  keyCreate:      vi.fn(), keyUpdate:      vi.fn(),
  setSsrfConfig:  vi.fn(), setGuardrailConfig: vi.fn(),
  setCostWeight:  vi.fn(), setCacheConfig:     vi.fn(),
  setNotificationConfig: vi.fn(), updateModelRegistry: vi.fn(),
}));

const reads = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() }));

vi.mock('../../lib/prisma', () => ({
  dbEngine: 'postgres',
  prisma: {
    nexusProvider: { create: writes.providerCreate, update: writes.providerUpdate,
                     findUnique: reads.findUnique, findMany: reads.findMany, delete: vi.fn(), count: reads.count },
    team:          { create: writes.teamCreate, update: writes.teamUpdate,
                     findUnique: reads.findUnique, findMany: reads.findMany, delete: vi.fn(), count: reads.count },
    nexusKey:      { create: writes.keyCreate, update: writes.keyUpdate,
                     findUnique: reads.findUnique, findMany: reads.findMany, delete: vi.fn(), count: reads.count },
    nexusTeamKey:  { findMany: reads.findMany, findUnique: reads.findUnique, create: vi.fn(),
                     update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: reads.count },
    appSettings:   { findMany: reads.findMany },
  },
}));

vi.mock('../../lib/redis',      () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../../lib/breaker',    () => ({ onSuccess: vi.fn() }));
vi.mock('../../lib/encryption', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s, maskKey: () => 'sk-…9f3a' }));
vi.mock('../../lib/lastUsed',   () => ({ forgetLastUsed: vi.fn() }));
vi.mock('../../lib/keyRowCache', () => ({ forgetKeyRow: vi.fn() }));

vi.mock('../../services/nexus.service', () => ({
  validateProviderCredentials: vi.fn(), validateModel: vi.fn(), fetchProviderModels: vi.fn(),
  testKey: vi.fn(), banKey: vi.fn(), coolKey: vi.fn(),
}));
vi.mock('../../services/model.service', () => ({
  removeModelsForProvider: vi.fn(), getModelRegistry: vi.fn(), updateModelRegistry: writes.updateModelRegistry,
  normalizeModel: (m: unknown) => m, removeModelById: vi.fn(), PRICING_SOURCES: ['catalog', 'manual'],
}));
vi.mock('../../services/providerCache.service', () => ({ invalidateProviderCache: vi.fn() }));
vi.mock('../../services/pricingCatalog.service', () => ({ getPricingCatalog: () => [] }));
vi.mock('../../services/budget.service',    () => ({ getCurrentSpend: vi.fn() }));
vi.mock('../../services/teamStats.service', () => ({ getTeamStats: vi.fn() }));
vi.mock('../../services/ssrf.service', () => ({
  getSsrfPolicy: vi.fn().mockResolvedValue({ allowPrivate: false, allowList: new Set<string>() }),
  getSsrfConfig: vi.fn().mockResolvedValue({ allowPrivate: false, allowList: [] }),
  setSsrfConfig: writes.setSsrfConfig,
}));
vi.mock('../../services/guardrails.service', () => ({
  getGuardrailConfigForUI: vi.fn().mockResolvedValue({}), setGuardrailConfig: writes.setGuardrailConfig,
}));
vi.mock('../../services/routing.service', () => ({
  getRoutingConfigForUI: vi.fn().mockResolvedValue({}), setCostWeight: writes.setCostWeight,
}));
vi.mock('../../services/cache.service', () => ({
  getCacheConfigForUI: vi.fn().mockResolvedValue({}), setCacheConfig: writes.setCacheConfig,
}));
vi.mock('../../services/notifications.service', () => ({
  getNotificationConfigForUI: vi.fn().mockResolvedValue({}), setNotificationConfig: writes.setNotificationConfig,
}));
vi.mock('../../services/settings.service', () => ({ setSetting: vi.fn() }));

import adminProvidersRoutes from './providers.routes';
import adminTeamsRoutes     from './teams.routes';
import adminKeysRoutes      from './keys.routes';
import adminSettingsRoutes  from './settings.routes';
import adminModelsRoutes    from './models.routes';

/**
 * Every route that validates a body, and one body each that will not validate.
 *
 * `write` is the mock that must NOT have been called. `secret` is present where the real body
 * carries a credential, and pins that a rejected credential is never handed back.
 */
const CASES: Array<{
  what: string; method: 'POST' | 'PATCH' | 'PUT'; url: string;
  payload: unknown; write: () => unknown; field?: string; secret?: string;
}> = [
  { what: 'create a provider pool', method: 'POST',  url: '/admin/providers',
    payload: { name: 'p', slug: 'p', provider: 'openai', tier: 'platinum' },
    write: () => writes.providerCreate, field: 'tier' },

  // A type mismatch rather than an unknown enum value, so the two provider cases exercise the two
  // ways a body goes wrong. `authHeader` is deliberately free text — see providerSchema — so only
  // the type is checkable, and `42` is what a UI sends when a field loses its input mask.
  { what: 'edit a provider pool',   method: 'PATCH', url: '/admin/providers/p1',
    payload: { authHeader: 42 },
    write: () => writes.providerUpdate, field: 'authHeader' },

  { what: 'create a team',          method: 'POST',  url: '/admin/teams',
    payload: { name: 'ops', budgetPeriod: 'fortnightly' },
    write: () => writes.teamCreate, field: 'budgetPeriod' },

  { what: 'edit a team',            method: 'PATCH', url: '/admin/teams/t1',
    payload: { status: 'deleted' },
    write: () => writes.teamUpdate, field: 'status' },

  { what: 'add a provider key',     method: 'POST',  url: '/admin/providers/p1/keys',
    payload: { apiKey: 'sk-ant-api03-REJECTED-CREDENTIAL-9f3a', rpmLimit: 0 },
    write: () => writes.keyCreate, field: 'rpmLimit', secret: 'sk-ant-api03-REJECTED-CREDENTIAL-9f3a' },

  { what: 'edit a provider key',    method: 'PATCH', url: '/admin/keys/k1',
    payload: { apiKey: 'sk-ant-api03-REJECTED-ON-EDIT-9f3a', tpmLimit: -1 },
    write: () => writes.keyUpdate, field: 'tpmLimit', secret: 'sk-ant-api03-REJECTED-ON-EDIT-9f3a' },

  { what: 'set the network policy', method: 'PUT',   url: '/admin/settings/ssrf',
    payload: { allowPrivate: false, allowList: ['http://not-a-bare-host/path'] },
    write: () => writes.setSsrfConfig, field: 'allowList.0' },

  { what: 'set guardrails',         method: 'PUT',   url: '/admin/settings/guardrails',
    payload: { enabled: true, bufferedSafe: true, rules: [{ name: 'r', pattern: 'x', action: 'delete' }] },
    write: () => writes.setGuardrailConfig, field: 'rules.0.action' },

  { what: 'set cost routing',       method: 'PUT',   url: '/admin/settings/routing',
    payload: { costWeight: 2 },
    write: () => writes.setCostWeight, field: 'costWeight' },

  { what: 'set the response cache', method: 'PUT',   url: '/admin/settings/cache',
    payload: { enabled: true, ttlSeconds: 0 },
    write: () => writes.setCacheConfig, field: 'ttlSeconds' },

  { what: 'set notifications',      method: 'PUT',   url: '/admin/settings/notifications',
    payload: { enabled: true, resendApiKey: 're_REJECTED_NOTIFY_KEY', to: ['not-an-address'] },
    write: () => writes.setNotificationConfig, field: 'to.0', secret: 're_REJECTED_NOTIFY_KEY' },

  { what: 'replace the model registry', method: 'PUT', url: '/admin/models',
    payload: { models: [{ id: 'm1' }] },
    write: () => writes.updateModelRegistry },
];

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminProvidersRoutes);
  await app.register(adminTeamsRoutes);
  await app.register(adminKeysRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminModelsRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  reads.findUnique.mockResolvedValue(null);
  reads.findMany.mockResolvedValue([]);
  reads.count.mockResolvedValue(0);
});

describe.each(CASES)('$method $url — $what', (c) => {
  it('answers 400, not 500', async () => {
    const res = await app.inject({ method: c.method, url: c.url, payload: c.payload as object });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('writes nothing', async () => {
    await app.inject({ method: c.method, url: c.url, payload: c.payload as object });
    expect(c.write()).not.toHaveBeenCalled();
  });

  it('says which field, in a sentence a person can read', async () => {
    const res  = await app.inject({ method: c.method, url: c.url, payload: c.payload as object });
    const body = res.json() as { error: string; details: Array<{ field: string; message: string }> };

    expect(body.error).toMatch(/[a-z]\.$/);          // a sentence, not a code
    expect(body.details.length).toBeGreaterThan(0);
    if (c.field) expect(body.details.map((d) => d.field)).toContain(c.field);
  });

  it('does not answer like Fastify', async () => {
    // web/src/api.ts reads `message` instead of `error` the moment `statusCode` is present, so a
    // body carrying it would show as Fastify's two-word "Bad Request" in the dashboard.
    const res = await app.inject({ method: c.method, url: c.url, payload: c.payload as object });
    expect(res.json()).not.toHaveProperty('statusCode');
  });

  if (c.secret) {
    it('does not hand the rejected credential back', async () => {
      const res = await app.inject({ method: c.method, url: c.url, payload: c.payload as object });
      expect(res.body).not.toContain(c.secret);
    });
  }
});

// ── Who is allowed to be told any of this ─────────────────────────────────────────────────────
//
// The 400 above is descriptive on purpose: it names fields, and across a handful of bad requests
// it describes the schema. That is the right answer for someone entitled to send the body, and the
// wrong answer for anyone else — so the authority check has to come first, and be seen to.
//
// Fastify runs `preHandler` before the route handler, so this holds by construction rather than by
// anyone remembering it. It is asserted anyway, because "by construction" is exactly the kind of
// claim that stops being true when a route is rewritten to validate in a hook.

describe('a caller who may not send the body at all', () => {
  const BAD = { method: 'POST' as const, url: '/admin/teams', payload: { budgetPeriod: 'fortnightly' } };

  it('is refused for being unauthenticated, not for the body', async () => {
    role = null;
    const res = await app.inject(BAD);

    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('details');
    expect(writes.teamCreate).not.toHaveBeenCalled();
  });

  it('is refused for lacking authority, not for the body', async () => {
    // A viewer must not be able to map the schema by posting rubbish at it and reading the answer.
    role = 'viewer';
    const res = await app.inject(BAD);

    expect(res.statusCode).toBe(403);
    expect(res.json()).not.toHaveProperty('details');
    expect(writes.teamCreate).not.toHaveBeenCalled();
  });

  it('is told which fields are wrong once it is an admin', async () => {
    // The other direction, so the two tests above are about authority and not about the fixture.
    role = 'admin';
    const res = await app.inject(BAD);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { details: unknown[] }).details.length).toBeGreaterThan(0);
  });
});

// ── The bodies that are not objects at all ────────────────────────────────────────────────────

describe('a body of the wrong shape entirely', () => {
  it('is a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/teams',
      payload: '"just a string"', headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(writes.teamCreate).not.toHaveBeenCalled();
  });

  it('blames the body rather than inventing a field', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/teams',
      payload: '42', headers: { 'content-type': 'application/json' },
    });
    const body = res.json() as { details: Array<{ field: string }> };
    expect(body.details[0].field).toBe('');
  });
});

// ── A valid body still goes through ───────────────────────────────────────────────────────────
//
// The half of the change that is easy to break silently: `safeParse` returns a wrapper, and
// reading `.data` off it is a step that did not exist before. Miss it on one route and that route
// writes `undefined` — or the whole wrapper — with no test failing.

describe('the valid body still reaches the write', () => {
  it('creates a team', async () => {
    writes.teamCreate.mockResolvedValue({ id: 't1' });
    const res = await app.inject({ method: 'POST', url: '/admin/teams', payload: { name: 'ops' } });
    expect(res.statusCode).toBe(201);
    expect((writes.teamCreate.mock.calls[0][0] as { data: { name: string } }).data.name).toBe('ops');
  });

  it('sets the cost weight to the number that was sent', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/settings/routing', payload: { costWeight: 0.25 } });
    expect(res.statusCode).toBe(200);
    expect(writes.setCostWeight).toHaveBeenCalledWith(0.25);
  });

  it('sets the cache from both fields, in order', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/settings/cache', payload: { enabled: true, ttlSeconds: 600 },
    });
    expect(res.statusCode).toBe(200);
    expect(writes.setCacheConfig).toHaveBeenCalledWith(true, 600);
  });

  it('sets the network policy from both fields, in order', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/settings/ssrf', payload: { allowPrivate: true, allowList: ['db:5432'] },
    });
    expect(res.statusCode).toBe(200);
    expect(writes.setSsrfConfig).toHaveBeenCalledWith(true, ['db:5432']);
  });

  it('passes notifications through with its defaults applied', async () => {
    // `.default()` is applied by safeParse exactly as it was by parse — this is the assertion that
    // says so, because a create that lost its defaults would write a config with no window.
    const res = await app.inject({
      method: 'PUT', url: '/admin/settings/notifications', payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(writes.setNotificationConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, windowSeconds: 3600, from: '', to: [] }),
    );
  });
});

// ── The guard that keeps the list above complete ───────────────────────────────────────────────

describe('no route validates a body by throwing', () => {
  // Deliberately all of `src`, not just `src/routes`. A route is where this defect appeared, but
  // nothing stops a service or a middleware from being handed `request.body` and parsing it there —
  // and the ZodError would escape from exactly the same place, with exactly the same result.
  const ROUTES = join(__dirname, '..', '..');

  /** Every .ts under src, tests excluded. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('uses safeParse, so no ZodError can escape into the error handler', () => {
    const offenders = sources(ROUTES).filter((path) => {
      const code = readFileSync(path, 'utf8')
        // Comments first — the fixed call sites explain themselves by quoting the old form.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return /\.parse\(\s*(request|req)\./.test(code);
    });

    expect(offenders.map((p) => p.replace(ROUTES, '')),
      'validate with safeParse and answer 400 via lib/invalidBody — a ZodError reaching the error '
      + 'handler is answered 500 on purpose, because it means a route forgot to validate, and that '
      + 'is this codebase\'s bug rather than the caller\'s',
    ).toEqual([]);
  });

  it('is looking at the files it thinks it is', () => {
    // A guard that scans an empty list passes forever. This is the assertion that the scan found
    // the routes at all — the reason it exists is that a previous guard in this repo shipped
    // green while checking nothing.
    const found = sources(ROUTES);
    expect(found.length).toBeGreaterThan(10);
    expect(found.some((p) => p.endsWith('providers.routes.ts'))).toBe(true);
    expect(found.some((p) => p.endsWith('settings.routes.ts'))).toBe(true);
    expect(found.some((p) => p.endsWith('server.ts'))).toBe(true);
  });
});

// ── The cap, over the wire ────────────────────────────────────────────────────────────────────

describe('a body that is wrong in many places', () => {
  /** Twelve rules, each missing `pattern` and carrying an action the schema does not know. */
  const payload = {
    enabled: true, bufferedSafe: true,
    rules: Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, action: 'delete' })),
  };

  it('is answered with a bounded list, not one entry per problem', async () => {
    const res  = await app.inject({ method: 'PUT', url: '/admin/settings/guardrails', payload });
    const body = res.json() as { details: unknown[]; omitted: number };

    expect(res.statusCode).toBe(400);
    expect(body.details).toHaveLength(5);
  });

  it('says how many it left out, so the cap is visible to the caller', async () => {
    const res  = await app.inject({ method: 'PUT', url: '/admin/settings/guardrails', payload });
    const body = res.json() as { details: unknown[]; omitted: number };

    // 12 rules × 2 problems each = 24, of which 5 are returned.
    expect(body.omitted).toBe(24 - 5);
    expect(writes.setGuardrailConfig).not.toHaveBeenCalled();
  });
});
