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

// Per-route rate-limit tiers (Phase 7.7c).
//
// The gateway already runs a global abuse guard (server.ts) sized ~12,000/min per credential — a
// blunt DoS cap, far too loose to slow a brute-force attempt at a password or a 6-digit TOTP code.
// These tighter, named tiers sit on the *sensitive* admin routes on top of that guard (and, for
// sign-in, on top of adminAuth's per-source lockout). They are applied per route via Fastify's
// `config.rateLimit`, which @fastify/rate-limit reads — the plugin is registered once in server.ts.
//
// Values are deliberately generous: they exist to stop abuse, not to inconvenience an operator or a
// polling dashboard. A route test asserts the AUTH tier actually returns 429 past its cap.

export interface RouteRateLimit { max: number; timeWindow: string }

/** Credential/second-factor verification — the brute-force surface. Tight, but well above any human
 *  retry rate (sign-in also trips a 5-attempt source lockout long before this). */
export const AUTH_RATE_LIMIT: RouteRateLimit = { max: 30, timeWindow: '1 minute' };

/** Authenticated admin mutations (delete a key, bust a cache). Modest — these are already behind the
 *  owner guard; the cap only blunts a runaway or scripted loop. */
export const ADMIN_WRITE_RATE_LIMIT: RouteRateLimit = { max: 60, timeWindow: '1 minute' };

/** Authenticated admin reads a dashboard may poll (per-key metrics). Loose, so normal polling across
 *  many keys is never throttled. */
export const ADMIN_READ_RATE_LIMIT: RouteRateLimit = { max: 300, timeWindow: '1 minute' };

/** Wrap a tier as a Fastify route `config` object for an unguarded route:
 *  `{ config: { rateLimit: tier } }`. */
export function rateLimited(tier: RouteRateLimit): { config: { rateLimit: RouteRateLimit } } {
  return { config: { rateLimit: tier } };
}

/** Merge a tier into an existing route-options object (e.g. `adminOwnerGuard`) without dropping its
 *  preHandler or any config it already carries. Use for guarded routes. */
export function withRateLimit<T extends object>(
  options: T,
  tier: RouteRateLimit,
): T & { config: Record<string, unknown> } {
  const existing = (options as { config?: Record<string, unknown> }).config ?? {};
  return { ...options, config: { ...existing, rateLimit: tier } };
}
