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

// `POST /v1/messages` takes a body as large as Anthropic's own limit for one Messages request, so a
// PDF that Anthropic accepts is not refused by the gateway first, and checks the caller's key before
// reading that body. The request handling itself is tested in the services.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';

vi.mock('../middleware/auth.middleware', () => ({
  verifyApiKey: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-api-key'] !== 'nexus-key') return reply.code(401).send({ error: 'Invalid API key' });
  },
}));
vi.mock('../middleware/maintenance.middleware', () => ({ refuseDuringMaintenance: async () => {} }));
const handled = vi.hoisted(() => ({ messages: vi.fn(), chat: vi.fn() }));
vi.mock('../services/anthropicMessages.service', () => ({
  handleAnthropicMessages: async (_b: unknown, reply: FastifyReply) => { handled.messages(); return reply.send({ ok: true }); },
}));
vi.mock('../services/completionsProxy.service', () => ({
  handleProxy: async (_b: unknown, reply: FastifyReply) => { handled.chat(); return reply.send({ ok: true }); },
}));
vi.mock('../services/proxyDispatch.service', () => ({
  dispatchProxy: vi.fn(), embeddingReserve: vi.fn(), completionReserve: vi.fn(),
  imageReserve: vi.fn(), imageQuantity: vi.fn(), speechReserve: vi.fn(), speechCharacters: vi.fn(),
}));
vi.mock('../services/byok.service', () => ({ resolveRequestScope: vi.fn() }));
vi.mock('../services/modelCatalog.service', () => ({ listServableModels: vi.fn() }));

import proxyRoutes, { MESSAGES_BODY_LIMIT } from './proxy';

let app: FastifyInstance;
beforeAll(async () => { app = Fastify(); await app.register(proxyRoutes); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); });

/** A Messages body carrying a base64 "PDF" of about `mb` megabytes. */
const withPdf = (mb: number) => JSON.stringify({
  model: 'claude-sonnet-4-5', max_tokens: 64,
  messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'A'.repeat(mb * 1024 * 1024) } }] }],
});
const send = (url: string, payload: string, key = 'nexus-key') =>
  app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', 'x-api-key': key } });

describe('POST /v1/messages', () => {
  it('matches Anthropic\'s 32 MB request limit', () => {
    expect(MESSAGES_BODY_LIMIT).toBe(32 * 1024 * 1024);
  });

  it('takes a 5 MB PDF that the chat endpoint\'s default limit refuses', async () => {
    const body = withPdf(5);
    expect((await send('/v1/messages', body)).statusCode).toBe(200);
    expect(handled.messages).toHaveBeenCalledTimes(1);
    expect((await send('/v1/chat/completions', body)).statusCode).toBe(413);
  });

  it('refuses a body over the limit', async () => {
    expect((await send('/v1/messages', withPdf(33))).statusCode).toBe(413);
    expect(handled.messages).not.toHaveBeenCalled();
  });

  it('checks the key before reading the body: a caller without one gets 401, not a parse error', async () => {
    const res = await send('/v1/messages', '{"not json', 'wrong');
    expect(res.statusCode).toBe(401);
    expect(handled.messages).not.toHaveBeenCalled();
  });
});
