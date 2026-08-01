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

/** A /64 is the smallest block an IPv6 host is normally assigned — four 16-bit groups. */
const IPV6_BUCKET_GROUPS = 4;

/** `::ffff:192.0.2.1` is an IPv4 address wearing an IPv6 costume; bucket it as the IPv4 it is. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/** Expand an IPv6 address to its eight groups, or null if it does not parse as one. */
function expandIpv6(ip: string): string[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null; // "::" may appear at most once

  if (halves.length === 1) {
    const groups = ip.split(':');
    return groups.length === 8 ? groups : null;
  }

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - head.length - tail.length;
  if (zeros < 0) return null;
  return [...head, ...Array<string>(zeros).fill('0'), ...tail];
}

/**
 * Reduce a client address to the bucket it should be rate-limited in.
 *
 * IPv4 is returned as-is: one address is one host, and addresses are scarce enough that nobody
 * rotates them casually.
 *
 * IPv6 is the problem, and it has two halves. A single customer /64 holds 2^64 addresses, so an
 * attacker limited to "their own" allocation still gets effectively unlimited buckets by picking a
 * new source address per request. And the *same* address can be written several ways —
 * `2001:db8::1`, `2001:0db8:0000:0000:0000:0000:0000:0001`, `2001:DB8::1` — so even without
 * rotating, rewriting the text defeats a limiter that keys on the string it was handed.
 *
 * So: canonicalise, then mask to the /64. Every address a single attacker plausibly controls lands
 * in one bucket, and the textual variants collapse onto each other.
 *
 * This mirrors what @fastify/rate-limit itself started doing in 11.2.0 (GHSA-grpc-p53c-r64v,
 * CVSS 7.3). That fix lives in the plugin's OWN key generator — and this gateway supplies a custom
 * one, so the upgrade alone would have left the bypass in place while making it look closed.
 *
 * Anything that does not parse is returned unchanged rather than thrown away. A malformed address
 * still deserves a bucket, and an exception here would take out the abuse guard entirely.
 */
export function ipBucket(rawIp: string): string {
  const ip = rawIp.trim().toLowerCase().split('%')[0]; // drop any %eth0 zone index
  if (!ip.includes(':')) return ip;                    // IPv4, or something that is not an address

  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped) return mapped[1];

  const groups = expandIpv6(ip);
  if (!groups) return ip;

  // Leading zeros are cosmetic: 0db8 and db8 are the same group.
  return groups
    .slice(0, IPV6_BUCKET_GROUPS)
    .map((g) => (g.replace(/^0+/, '') || '0'))
    .join(':') + '::/64';
}

/**
 * Derive the abuse-guard rate-limit bucket key for an incoming request.
 *
 * Per-credential when a Bearer token is present — the token is SHA-256 hashed so
 * the raw secret is never used as (or stored in) a Redis key, and each distinct
 * credential gets its own bucket, isolating a leaked or runaway key from the rest
 * of the gateway. Falls back to the client IP for missing/malformed auth.
 *
 * The fallback is the path that matters for abuse: an unauthenticated request is exactly what
 * sign-in, password reset and invite redemption are, and those are the endpoints a rate limit is
 * protecting in the first place. See `ipBucket` for why the raw address is not the key.
 *
 * Pure and deterministic (no Fastify request, no I/O) so it is unit-testable in
 * isolation. Used by the `@fastify/rate-limit` keyGenerator in server.ts.
 */
export function deriveRateLimitKey(authHeader: string | undefined, ip: string): string {
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return 'tk:' + createHash('sha256').update(token).digest('hex');
  }
  return 'ip:' + ipBucket(ip);
}
