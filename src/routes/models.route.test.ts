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

// `GET /v1/models` had no test at all. It returned a hardcoded object, so there was nothing
// to assert that reading the source did not already tell you — and nothing to catch the fact
// that the object bore no relation to the models the operator had configured.
//
// What is under test here is the WIRE SHAPE, because two different client families parse this
// one response: an OpenAI client reads `object` and `data[].id`, and an Anthropic client such
// as Claude Code reads `data[].display_name` and the `has_more`/`first_id`/`last_id`
// pagination fields. Dropping either half breaks a whole ecosystem silently — the request
// succeeds, the model picker is just empty. The catalogue itself is tested against the
// registry in modelCatalog.service.test.ts; here it is stubbed so the response is the subject.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

const h = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[], scopeSeen: null as unknown }));

vi.mock('../middleware/auth.middleware', () => ({
  verifyApiKey: async (request: FastifyRequest) => {
    (request as FastifyRequest & { team?: unknown }).team = { id: 't1', byokFallback: false };
  },
}));
vi.mock('../middleware/maintenance.middleware', () => ({ refuseDuringMaintenance: async () => {} }));
vi.mock('../services/completionsProxy.service', () => ({ handleProxy: vi.fn() }));
vi.mock('../services/proxyDispatch.service', () => ({
  dispatchProxy: vi.fn(), embeddingReserve: vi.fn(), completionReserve: vi.fn(),
  imageReserve: vi.fn(), imageQuantity: vi.fn(), speechReserve: vi.fn(), speechCharacters: vi.fn(),
}));
vi.mock('../services/byok.service', () => ({
  resolveRequestScope: vi.fn(async () => ({ ownerTeamId: 't1', fallbackToShared: false, namespace: 'team:t1' })),
}));
vi.mock('../services/modelCatalog.service', () => ({
  listServableModels: vi.fn(async (scope: unknown) => { h.scopeSeen = scope; return h.entries; }),
}));

import proxyRoutes from './proxy';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(proxyRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(() => {
  h.entries = [
    { id: 'alayra-nexus-1', displayName: 'Alayra Nexus (auto-route)', provider: 'alayra-nexus', capabilities: [], contextWindow: 0, maxTokens: 0, auto: true },
    { id: 'gpt4o', displayName: 'GPT-4o', provider: 'openai', capabilities: ['chat'], contextWindow: 128_000, maxTokens: 4096, auto: false },
  ];
  h.scopeSeen = null;
});

async function list() {
  const res = await app.inject({ method: 'GET', url: '/v1/models' });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('GET /v1/models', () => {
  it('serves the catalogue, not a hardcoded model', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect((body.data as { id: string }[]).map((m) => m.id)).toEqual(['alayra-nexus-1', 'gpt4o']);
  });

  it('satisfies an OpenAI client: object=list and an id per entry', async () => {
    const { body } = await list();
    expect(body.object).toBe('list');
    for (const m of body.data as Record<string, unknown>[]) {
      expect(typeof m.id).toBe('string');
      expect(m.object).toBe('model');
      expect(typeof m.created).toBe('number');
    }
  });

  it('satisfies an Anthropic client: display_name and the pagination triple', async () => {
    const { body } = await list();
    const data = body.data as Record<string, unknown>[];
    expect(data.map((m) => m.display_name)).toEqual(['Alayra Nexus (auto-route)', 'GPT-4o']);
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe('alayra-nexus-1');
    expect(body.last_id).toBe('gpt4o');
  });

  it('attributes each model to the provider serving it', async () => {
    const { body } = await list();
    expect((body.data as { owned_by: string }[]).map((m) => m.owned_by)).toEqual(['alayra-nexus', 'openai']);
  });

  it('publishes the context window and capabilities a client can plan against', async () => {
    const { body } = await list();
    const gpt = (body.data as Record<string, unknown>[])[1];
    expect(gpt).toMatchObject({ context_window: 128_000, max_tokens: 4096, capabilities: ['chat'] });
  });

  it('omits empty metadata rather than publishing zeroes', async () => {
    // A client that reads `context_window: 0` would conclude the model takes no input.
    const { body } = await list();
    const auto = (body.data as Record<string, unknown>[])[0];
    expect(auto).not.toHaveProperty('context_window');
    expect(auto).not.toHaveProperty('capabilities');
  });

  it('asks for the catalogue in the caller\'s own scope', async () => {
    // A hard-isolated team must not be shown models only the shared pool can reach.
    await list();
    expect(h.scopeSeen).toMatchObject({ ownerTeamId: 't1', fallbackToShared: false });
  });

  it('stays a well-formed empty list rather than sending nulls a client will choke on', async () => {
    h.entries = [];
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.first_id).toBeNull();
    expect(body.last_id).toBeNull();
  });
});
