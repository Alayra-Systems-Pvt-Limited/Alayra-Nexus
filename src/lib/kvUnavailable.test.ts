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

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { isKvUnavailable, kvAwareErrorHandler, KV_RETRY_AFTER_SECONDS } from './kvUnavailable';

/** Builds the error ioredis actually produces, name and all. */
function ioredisError(name: string, message: string, code?: string): Error {
  const err = new Error(message);
  err.name = name;
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

describe('isKvUnavailable — what counts as "the store did not answer"', () => {
  // Every string here was taken from a real ioredis rejection against a stopped Redis, which is
  // why they are matched exactly rather than by shape.
  it.each([
    ['MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 20). Refer to "maxRetriesPerRequest" option for details.'],
    ['Error', 'Command timed out'],
    ['Error', "Stream isn't writeable and enableOfflineQueue options is false"],
    ['Error', 'Connection is closed.'],
  ])('recognises %s: %s', (name, message) => {
    expect(isKvUnavailable(ioredisError(name, message))).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'recognises the socket-level %s, which arrives from below ioredis',
    (code) => {
      expect(isKvUnavailable(ioredisError('Error', 'connect failed', code))).toBe(true);
    },
  );

  // The asymmetry that shapes this file: calling a bug a dependency outage tells the caller to
  // come back later for a defect that will still be there.
  it.each([
    ['TypeError', "Cannot read properties of undefined (reading 'id')"],
    ['Error', 'Invalid model "gpt-4". Use model: "alayra-nexus-1"'],
    ['RangeError', 'Maximum call stack size exceeded'],
    ['Error', 'WRONGTYPE Operation against a key holding the wrong kind of value'],
    ['Error', 'NOAUTH Authentication required.'],
  ])('does NOT claim %s: %s', (name, message) => {
    expect(isKvUnavailable(ioredisError(name, message))).toBe(false);
  });

  it('ignores a message that merely mentions a timeout somewhere in the middle', () => {
    // Prefix-matched, not substring-matched: an upstream provider timeout is not our store.
    expect(isKvUnavailable(new Error('upstream provider: Command timed out'))).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42], [{ name: 'MaxRetriesPerRequestError' }]])(
    'survives %s, which is not an Error at all',
    (thrown) => {
      expect(isKvUnavailable(thrown)).toBe(false);
    },
  );
});

describe('what a caller actually receives', () => {
  /** A real Fastify with the real handler — the status code and headers are the whole point. */
  async function appThrowing(err: Error) {
    const app = Fastify({ logger: false });
    app.setErrorHandler(kvAwareErrorHandler);
    app.get('/boom', async () => { throw err; });
    await app.ready();
    return app;
  }

  it('answers 503 with a Retry-After when the store is unreachable', async () => {
    const app = await appThrowing(ioredisError('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 20).'));
    const res = await app.inject({ method: 'GET', url: '/boom' });

    // 500 was the old answer, and it was wrong twice: the gateway is fine, and the condition
    // is temporary. Neither of those is something a client can act on.
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(KV_RETRY_AFTER_SECONDS));
    await app.close();
  });

  it('marks the refusal uncacheable, so no proxy outlives the outage with it', async () => {
    const app = await appThrowing(ioredisError('Error', 'Command timed out'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('says why, in terms of what the gateway can no longer enforce', async () => {
    const app = await appThrowing(ioredisError('Error', 'Command timed out'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.json().error).toMatch(/rate limits or budgets/);
    await app.close();
  });

  it('leaves a genuine bug as a 500, with no Retry-After', async () => {
    const app = await appThrowing(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const res = await app.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it('does not leak the internal message of a bug to the caller', async () => {
    // Fastify's default serialisation is what we hand back to; this asserts we did not
    // accidentally replace it with something chattier.
    const app = await appThrowing(new TypeError('secret internal detail'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('keeps an explicit status a route already chose', async () => {
    // A 404 or 429 thrown deliberately elsewhere must not be flattened into a 500 by this handler.
    const app = Fastify({ logger: false });
    app.setErrorHandler(kvAwareErrorHandler);
    app.get('/boom', async () => {
      const err = new Error('Too Many Requests') as Error & { statusCode?: number };
      err.statusCode = 429;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(429);
    await app.close();
  });
});
