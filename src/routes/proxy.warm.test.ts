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

// The proxy routes load the tokenizer's ranks when the server starts listening, so the first
// request that needs an exact count does not pay for the load. The server registers these routes in
// every worker before it listens (server.ts), so this is the boot path. The services behind the
// routes are stubbed: this is about the hook, not the request handling.

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock('../lib/bpeCount', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/bpeCount')>();
  return { ...real, loadCl100k: () => { loads.n++; } };
});
vi.mock('../middleware/auth.middleware', () => ({ verifyApiKey: async () => {} }));
vi.mock('../middleware/maintenance.middleware', () => ({ refuseDuringMaintenance: async () => {} }));
vi.mock('../services/anthropicMessages.service', () => ({ handleAnthropicMessages: vi.fn() }));
vi.mock('../services/completionsProxy.service', () => ({ handleProxy: vi.fn() }));
vi.mock('../services/proxyDispatch.service', () => ({
  dispatchProxy: vi.fn(), embeddingReserve: vi.fn(), completionReserve: vi.fn(),
  imageReserve: vi.fn(), imageQuantity: vi.fn(), speechReserve: vi.fn(), speechCharacters: vi.fn(),
}));
vi.mock('../services/byok.service', () => ({ resolveRequestScope: vi.fn() }));
vi.mock('../services/modelCatalog.service', () => ({ listServableModels: vi.fn() }));

import proxyRoutes from './proxy';

describe('the proxy routes warm the tokenizer', () => {
  it('once the server is listening, and not before', async () => {
    const app = Fastify();
    await app.register(proxyRoutes);
    try {
      await app.ready();
      await new Promise((resolve) => setImmediate(resolve));
      expect(loads.n).toBe(0); // ready() alone, as inject()-based tests run, loads nothing

      await app.listen({ port: 0, host: '127.0.0.1' });
      await vi.waitFor(() => expect(loads.n).toBe(1));
    } finally {
      await app.close();
    }
  });
});
