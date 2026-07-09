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

import { createHash } from 'crypto';

/**
 * Derive the abuse-guard rate-limit bucket key for an incoming request.
 *
 * Per-credential when a Bearer token is present — the token is SHA-256 hashed so
 * the raw secret is never used as (or stored in) a Redis key, and each distinct
 * credential gets its own bucket, isolating a leaked or runaway key from the rest
 * of the gateway. Falls back to the client IP for missing/malformed auth.
 *
 * Pure and deterministic (no Fastify request, no I/O) so it is unit-testable in
 * isolation. Used by the `@fastify/rate-limit` keyGenerator in server.ts.
 */
export function deriveRateLimitKey(authHeader: string | undefined, ip: string): string {
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return 'tk:' + createHash('sha256').update(token).digest('hex');
  }
  return 'ip:' + ip;
}
