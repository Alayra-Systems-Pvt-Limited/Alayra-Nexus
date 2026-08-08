/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Refusing a key that does not belong to the pool it is being added to, driven through a real
// Fastify.
//
// ── The gap this closes ───────────────────────────────────────────────────────────────────────
//
// `keyPrefix.test.ts` already covers the offline half in isolation: which prefixes identify which
// issuer, and that an unrecognised key must pass. What it cannot reach is the part that lives in
// the route — WHICH provider responses are treated as evidence that a credential is wrong.
//
// That rule is narrow on purpose and reads as arbitrary if you meet it in the diff: 401 and 403
// refuse the save, and every other outcome lets it through. It is easy for a later change to
// "improve" that into `if (!result.ok)`, which is wrong in a way nothing else here would notice —
// plenty of providers answer 404 to the `/models` probe because they do not serve that route, and a
// timeout means the network is unhappy rather than that the key is bad. Under `!result.ok` a
// perfectly good credential becomes unsavable whenever the provider is having a bad afternoon, and
// the operator is locked out of the fix at exactly the moment they need it.
//
// So this drives each outcome through the real route and asserts on which side of the line it
// lands. Prisma and the provider call are stubbed — the network is what is being decided about, not
// what is being tested.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest) => {
    (request as FastifyRequest & { adminRole?: string }).adminRole = 'owner';
  },
}));

const db = vi.hoisted(() => ({
  poolRow: {
    provider: 'anthropic', baseUrl: null,
    authHeader: 'x-api-key', authPrefix: null, extraHeaders: null,
  } as Record<string, unknown> | null,
  create: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    nexusProvider: { findUnique: async () => db.poolRow },
    nexusKey:      { create: db.create, findMany: async () => [] },
    team:          { findUnique: async () => ({ id: 't1' }) },
  },
}));

const validate = vi.hoisted(() => vi.fn());
vi.mock('../../services/nexus.service', () => ({
  validateProviderCredentials: validate,
  testKey: vi.fn(), banKey: vi.fn(), coolKey: vi.fn(),
}));

vi.mock('../../lib/encryption', () => ({
  encrypt:  (s: string) => `enc:${s}`,
  maskKey:  (s: string) => `${s.slice(0, 4)}…`,
}));
vi.mock('../../lib/redis',        () => ({ redis: { get: async () => null } }));
vi.mock('../../lib/breaker',      () => ({ onSuccess: vi.fn() }));
vi.mock('../../lib/lastUsed',     () => ({ forgetLastUsed: vi.fn() }));
vi.mock('../../lib/keyRowCache',  () => ({ forgetKeyRow: vi.fn() }));

let app: FastifyInstance;

/** The provider answered with this status. `null` stands for a thrown fetch — a timeout or a DNS
 *  failure — which is what `validateProviderCredentials` reports as `ok: false` with no status. */
function providerAnswers(status: number | null) {
  validate.mockResolvedValue(
    status === null
      ? { ok: false, latencyMs: 8000, error: 'The operation was aborted due to timeout' }
      : { ok: status < 400, status, latencyMs: 12, error: status < 400 ? undefined : `HTTP ${status}` },
  );
}

const addKey = (apiKey: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url:    '/admin/providers/p1/keys',
    payload: { apiKey, ...extra },
  });

beforeAll(async () => {
  const routes = (await import('./keys.routes')).default;
  app = Fastify();
  await app.register(routes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  db.poolRow = {
    provider: 'anthropic', baseUrl: null,
    authHeader: 'x-api-key', authPrefix: null, extraHeaders: null,
  };
  db.create.mockReset();
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  validate.mockReset();
  providerAnswers(200);
});

describe('the prefix check', () => {
  it('refuses another provider\'s unmistakable key without calling the provider', async () => {
    const res = await addKey('sk-or-v1-abcdef0123456789');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('an OpenRouter key');
    expect(res.json().error).toContain('this pool is Anthropic');
    // The point of doing this offline: nothing was written, and nothing was asked of the network.
    expect(validate).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it('lets a matching key through to the live check', async () => {
    const res = await addKey('sk-ant-api03-abcdef0123456789');

    expect(res.statusCode).toBe(201);
    expect(validate).toHaveBeenCalledOnce();
  });

  it('lets an unstamped key through — unrecognised is not evidence of a mistake', async () => {
    // Mistral and most self-hosted providers stamp nothing, and OpenAI's bare `sk-` is shared by
    // every OpenAI-compatible provider that copied it. Refusing here would refuse valid keys.
    const res = await addKey('sk-plainoldopenaistylekey0123456789');

    expect(res.statusCode).toBe(201);
  });

  it('checks nothing for a custom pool, whose keys can look like anything', async () => {
    db.poolRow = {
      provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1',
      authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
    };
    const res = await addKey('sk-ant-api03-abcdef0123456789'); // would be a mismatch anywhere else

    expect(res.statusCode).toBe(201);
  });
});

describe('the live check: which provider answers refuse a save', () => {
  const key = 'sk-ant-api03-abcdef0123456789';

  it.each([401, 403])('refuses on %i — the provider itself says the credential is wrong', async (status) => {
    providerAnswers(status);
    const res = await addKey(key);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`Anthropic rejected this key (HTTP ${status})`);
    expect(db.create).not.toHaveBeenCalled();
  });

  it.each([404, 405, 429, 500, 503])('saves anyway on %i — that is the provider, not the key', async (status) => {
    providerAnswers(status);
    const res = await addKey(key);

    expect(res.statusCode).toBe(201);
    expect(db.create).toHaveBeenCalledOnce();
  });

  it('saves anyway when the call never completed', async () => {
    // A timeout or a DNS failure. The gateway learned nothing about the credential, and an operator
    // adding a key during an outage is the one who can least afford to be refused.
    providerAnswers(null);
    const res = await addKey(key);

    expect(res.statusCode).toBe(201);
  });
});

describe('opting out', () => {
  it('skips the provider call on verify:false but still refuses a positive mismatch', async () => {
    // The escape hatch is for an air-gapped pool or a provider that is down, so it drops the call
    // that needs the network. It does not drop the offline check, which needed nothing and is
    // certain — there is no deployment in which an OpenRouter key belongs in an Anthropic pool.
    const bad = await addKey('sk-or-v1-abcdef0123456789', { verify: false });
    expect(bad.statusCode).toBe(400);

    const ok = await addKey('sk-ant-api03-abcdef0123456789', { verify: false });
    expect(ok.statusCode).toBe(201);
    expect(validate).not.toHaveBeenCalled();
  });

  it('verifies by default, so an operator gets the check without knowing to ask', async () => {
    providerAnswers(401);
    const res = await addKey('sk-ant-api03-abcdef0123456789'); // no `verify` in the body

    expect(res.statusCode).toBe(400);
  });
});

describe('rotating a key', () => {
  it('is checked the same way a create is', async () => {
    // Rotating a working key to a wrong one is the worse case: the pool served traffic a minute
    // ago, so the eventual 401 storm is even harder to connect back to this action.
    const prisma = (await import('../../lib/prisma')).prisma as unknown as {
      nexusKey: Record<string, unknown>;
    };
    prisma.nexusKey.findUnique = async () => ({
      provider: {
        provider: 'anthropic', baseUrl: null,
        authHeader: 'x-api-key', authPrefix: null, extraHeaders: null,
      },
    });
    prisma.nexusKey.update = async ({ data }: { data: Record<string, unknown> }) => data;

    const res = await app.inject({
      method: 'PATCH', url: '/admin/keys/k1',
      payload: { apiKey: 'sk-or-v1-abcdef0123456789' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('an OpenRouter key');
  });
});
