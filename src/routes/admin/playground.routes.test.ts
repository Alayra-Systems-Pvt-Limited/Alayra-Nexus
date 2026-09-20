import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

let role: string | null = 'owner';

vi.mock('../../middleware/auth.middleware', () => ({
  verifyAdminPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    if (role === null) return reply.code(401).send({ error: 'Not signed in.' });
    (request as FastifyRequest & { adminRole?: string }).adminRole = role;
  },
}));

const mocks = vi.hoisted(() => ({
  handleProxy: vi.fn(),
  listServableModels: vi.fn(),
  resolveRequestScope: vi.fn(),
}));

vi.mock('../../services/completionsProxy.service', () => ({
  handleProxy: mocks.handleProxy,
}));
vi.mock('../../services/modelCatalog.service', () => ({
  listServableModels: mocks.listServableModels,
}));
vi.mock('../../services/byok.service', () => ({
  resolveRequestScope: mocks.resolveRequestScope,
}));

import adminPlaygroundRoutes from './playground.routes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminPlaygroundRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  mocks.resolveRequestScope.mockResolvedValue({ namespace: 'shared' });
  mocks.listServableModels.mockResolvedValue([
    {
      id: 'alayra-nexus-1', displayName: 'Auto — Nexus routing', provider: 'alayra-nexus',
      capabilities: ['chat'], contextWindow: 0, maxTokens: 0, auto: true,
    },
    {
      id: 'chat-model', displayName: 'Chat model', provider: 'groq',
      capabilities: ['chat'], contextWindow: 8192, maxTokens: 2048, auto: false,
    },
    {
      id: 'embed-model', displayName: 'Embed model', provider: 'openai',
      capabilities: ['embedding'], contextWindow: 8192, maxTokens: 0, auto: false,
    },
  ]);
  mocks.handleProxy.mockImplementation(async (
    _body: unknown,
    reply: FastifyReply,
    _teamKeyId: unknown,
    _headers: unknown,
    _team: unknown,
    trace: { route?: unknown; outcome?: string },
  ) => {
    trace.route = { provider: 'groq', modelString: 'chat-model' };
    trace.outcome = 'success';
    reply.hijack();
    reply.raw.writeHead(200, { 'X-Nexus-Model': 'chat-model' });
    reply.raw.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });
});

describe('Playground model discovery', () => {
  it('lists only models that this gateway can serve for chat', async () => {
    role = 'viewer';
    const response = await app.inject({ method: 'GET', url: '/admin/playground/models' });

    expect(response.statusCode).toBe(200);
    expect(response.json().models.map((model: { id: string }) => model.id))
      .toEqual(['alayra-nexus-1', 'chat-model']);
  });

  it('still requires a signed-in dashboard session', async () => {
    role = null;
    expect((await app.inject({ method: 'GET', url: '/admin/playground/models' })).statusCode).toBe(401);
  });
});

describe('running the Playground', () => {
  const payload = {
    model: 'alayra-nexus-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
    temperature: 0.7,
    maxTokens: 256,
  };

  it('refuses viewers before spending provider capacity', async () => {
    role = 'viewer';
    const response = await app.inject({ method: 'POST', url: '/admin/playground/run', payload });
    expect(response.statusCode).toBe(403);
    expect(mocks.handleProxy).not.toHaveBeenCalled();
  });

  it('returns a bounded 400 for a malformed body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/playground/run',
      payload: { ...payload, messages: [{ role: 'user', content: 'not parts' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Provide a valid Playground request.');
    expect(mocks.handleProxy).not.toHaveBeenCalled();
  });

  it('streams the real proxy output and finishes with its routing result', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/playground/run', payload });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: upstream');
    expect(response.body).toContain('Hello');
    expect(response.body).toContain('event: result');
    expect(response.body).toContain('"modelString":"chat-model"');

    const [body, , , headers] = mocks.handleProxy.mock.calls[0];
    expect(body).toMatchObject({
      model: 'alayra-nexus-1',
      messages: [{ role: 'user', content: 'Say hello' }],
      stream: true,
      temperature: 0.7,
      max_tokens: 256,
    });
    expect(headers).toMatchObject({ 'x-nexus-cache-bypass': '1' });
  });
});
