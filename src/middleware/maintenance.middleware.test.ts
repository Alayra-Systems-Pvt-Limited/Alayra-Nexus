/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The gate itself, against a real Fastify instance (Phase A4).
//
// The assertion that matters is not the status code — it is that the gate runs BEFORE the
// preHandler. `verifyApiKey` resolves the caller's key against the database, and a `replace`
// restore holds that table under ACCESS EXCLUSIVE for its whole duration. A gate placed after
// authentication would block inside authentication, hanging in exactly the situation it exists to
// stop hanging in. So the test wires a preHandler that stands in for that database call and proves
// it is never reached.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { readMaintenance } = vi.hoisted(() => ({ readMaintenance: vi.fn() }));
vi.mock('../services/maintenance.service', () => ({ readMaintenance }));

import { refuseDuringMaintenance } from './maintenance.middleware';

/** Stands in for verifyApiKey: the preHandler that would touch the locked table. */
let touchedTheDatabase = false;
let reachedTheHandler = false;

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', refuseDuringMaintenance);
  app.post('/v1/chat/completions', {
    preHandler: [async () => { touchedTheDatabase = true; }],
  }, async () => { reachedTheHandler = true; return { ok: true }; });
  await app.ready();
  return app;
}

const ACTIVE = {
  reason: 'a backup is being restored',
  startedAt: 0, rowsWritten: 2_000, rowsExpected: 10_000, updatedAt: 0,
  elapsedMs: 4_000, percent: 20, etaSeconds: 16, retryAfterSeconds: 16,
};

beforeEach(() => {
  vi.clearAllMocks();
  touchedTheDatabase = false;
  reachedTheHandler = false;
});

describe('while a restore is running', () => {
  it('refuses with 503 and a Retry-After carrying the live estimate', async () => {
    readMaintenance.mockResolvedValue(ACTIVE);
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('16');
    await app.close();
  });

  it('never reaches the preHandler that would read the locked table', async () => {
    // THE point of the whole design. If this ever fails, the gate has been moved behind
    // authentication and the gateway will hang instead of answering.
    readMaintenance.mockResolvedValue(ACTIVE);
    const app = await build();

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });

    expect(touchedTheDatabase).toBe(false);
    expect(reachedTheHandler).toBe(false);
    await app.close();
  });

  it('tells the caller what is happening and how far along it is', async () => {
    readMaintenance.mockResolvedValue(ACTIVE);
    const app = await build();

    const body = (await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} })).json();

    expect(body.error).toContain('a backup is being restored');
    expect(body.maintenance).toEqual({
      reason: 'a backup is being restored', percent: 20, etaSeconds: 16, retryAfterSeconds: 16,
    });
    await app.close();
  });

  it('is never cached, so the refusal does not outlive the restore', async () => {
    readMaintenance.mockResolvedValue(ACTIVE);
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('still answers when there is no estimate yet', async () => {
    readMaintenance.mockResolvedValue({ ...ACTIVE, percent: null, etaSeconds: null, retryAfterSeconds: 30 });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    await app.close();
  });
});

describe('the rest of the time', () => {
  it('lets the request through untouched', async () => {
    readMaintenance.mockResolvedValue(null);
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(touchedTheDatabase).toBe(true);
    expect(reachedTheHandler).toBe(true);
    await app.close();
  });
});
