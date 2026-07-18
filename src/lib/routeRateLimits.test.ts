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
import rateLimit from '@fastify/rate-limit';
import { AUTH_RATE_LIMIT, ADMIN_READ_RATE_LIMIT, rateLimited, withRateLimit } from './routeRateLimits';

describe('route rate-limit tiers', () => {
  it('rateLimited wraps a tier as a Fastify route config', () => {
    expect(rateLimited(AUTH_RATE_LIMIT)).toEqual({ config: { rateLimit: { max: 30, timeWindow: '1 minute' } } });
  });

  it('withRateLimit merges the tier into a guard without dropping its preHandler', () => {
    const guard = { preHandler: [async () => {}] };
    const merged = withRateLimit(guard, ADMIN_READ_RATE_LIMIT);
    expect(merged.preHandler).toBe(guard.preHandler);         // guard preserved
    expect(merged.config.rateLimit).toEqual({ max: 300, timeWindow: '1 minute' });
  });

  it('preserves config a guard already carries when adding the limit', () => {
    const merged = withRateLimit({ preHandler: [], config: { existing: true } }, AUTH_RATE_LIMIT);
    expect(merged.config).toEqual({ existing: true, rateLimit: AUTH_RATE_LIMIT });
  });

  // The proof that matters: a per-route cap actually returns 429 once exceeded. Global is off, so
  // only the route's own `config.rateLimit` is in force — the same mechanism the admin routes use.
  //
  // keyGenerator is pinned to a constant on purpose. The plugin's in-memory counter is fully
  // deterministic for a fixed bucket key (1→2→3→4, and the 4th trips max:3), and the ONLY variable
  // input is the key, which defaults to `req.ip`. Under `app.inject` the resolved IP can vary — and
  // one request landing in a different bucket makes the 4th a 200 instead of the expected 429. That
  // was this file's long-standing rare flake under full-suite load. Fixing the key to one value
  // removes the only nondeterminism while proving exactly the same thing: the 4th in-window request
  // to this route is throttled.
  it('returns 429 once a route’s per-route cap is exceeded', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false, keyGenerator: () => 'probe-bucket' });
    app.get('/probe', rateLimited({ max: 3, timeWindow: '1 minute' }), async () => ({ ok: true }));

    const hit = () => app.inject({ method: 'GET', url: '/probe' });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429); // the fourth within the window is throttled

    await app.close();
  });
});
