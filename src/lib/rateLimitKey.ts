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
