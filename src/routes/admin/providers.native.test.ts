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

// A pool's Anthropic Messages settings (`nativeMessages`), as the admin API takes them: the shape is
// checked, and what passes is stored as the JSON string the column holds. The rest of the providers
// API is covered in providers.routes.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest) => { (request as FastifyRequest & { adminRole?: string }).adminRole = 'owner'; },
}));
const db = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), findUnique: vi.fn() }));
vi.mock('../../lib/prisma', () => ({ dbEngine: 'postgres', prisma: { nexusProvider: db } }));
vi.mock('../../services/nexus.service', () => ({ validateProviderCredentials: vi.fn(), validateModel: vi.fn(), fetchProviderModels: vi.fn() }));
vi.mock('../../services/model.service', () => ({ removeModelsForProvider: vi.fn() }));
vi.mock('../../services/providerCache.service', () => ({ invalidateProviderCache: vi.fn(async () => {}) }));
vi.mock('../../services/ssrf.service', () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: false, allowList: new Set<string>() })) }));

import adminProvidersRoutes from './providers.routes';

const VALID = { name: 'Anthropic', slug: 'anthropic-prod', provider: 'anthropic', authHeader: 'x-api-key', authPrefix: '' };
let app: FastifyInstance;

beforeAll(async () => { app = Fastify({ logger: false }); await app.register(adminProvidersRoutes); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  db.findUnique.mockResolvedValue(null);
  db.create.mockImplementation(async ({ data }) => data);
  db.update.mockImplementation(async ({ data }) => data);
});

const dataOf = (m: { mock: { calls: unknown[][] } }) => (m.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('nativeMessages', () => {
  it('stores the switch and the allow list as the JSON string the column holds', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/providers', payload: { ...VALID, nativeMessages: { enabled: true, allow: ['speed', 'code_execution'] } } });
    expect(res.statusCode).toBe(201);
    expect(dataOf(db.create).nativeMessages).toBe('{"enabled":true,"allow":["speed","code_execution"]}');
  });

  it('clears it on null or an empty object, and leaves it alone when not mentioned', async () => {
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { nativeMessages: null } });
    expect(dataOf(db.update).nativeMessages).toBeNull();
    vi.clearAllMocks();
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { nativeMessages: {} } });
    expect(dataOf(db.update).nativeMessages).toBeNull();
    vi.clearAllMocks();
    await app.inject({ method: 'PATCH', url: '/admin/providers/p1', payload: { name: 'Renamed' } });
    expect('nativeMessages' in dataOf(db.update)).toBe(false);
  });

  it.each([
    ['an unknown key', { allow: ['speed'], everything: true }],
    ['a name that is not a plain token', { allow: ['speed; drop'] }],
    ['a switch that is not a boolean', { enabled: 'yes' }],
    ['a list that is not a list', { allow: 'speed' }],
  ])('refuses %s', async (_name, nativeMessages) => {
    const res = await app.inject({ method: 'POST', url: '/admin/providers', payload: { ...VALID, nativeMessages } });
    expect(res.statusCode).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
  });
});
