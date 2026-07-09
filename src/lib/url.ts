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

/**
 * Strip trailing slashes without a regex. The previous `/\/+$/` form was flagged
 * as a potential polynomial-backtracking (ReDoS) pattern on uncontrolled input;
 * this linear scan removes any ambiguity.
 */
export function stripTrailingSlash(s: string): string {
  let i = s.length;
  while (i > 0 && s[i - 1] === '/') i--;
  return s.slice(0, i);
}

/**
 * Validate a provider base URL and return it as a parsed URL. Rejects anything
 * that is not plain HTTP(S) — blocking `file:`, `gopher:`, and similar schemes
 * that could be abused through the gateway's outbound fetch. This is the scheme
 * check only; host-level SSRF protection is layered on top by assertSafeUrl.
 */
export function assertHttpUrl(raw: string): URL {
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${u.protocol}" — provider base URL must be http(s).`);
  }
  return u;
}

// ── SSRF protection ───────────────────────────────────────────────────────────
// The gateway makes outbound requests to operator-supplied base URLs. Without a
// host restriction that lets it be pointed at internal-only addresses — cloud
// metadata (169.254.169.254), loopback admin panels, private LAN hosts — turning
// Nexus into a confused-deputy proxy. By default those hosts are blocked; an
// operator running a legitimate local provider (Ollama, LM Studio) allowlists the
// specific host, or disables blocking entirely for a fully trusted network.

export interface SsrfPolicy {
  /** When true, private/loopback/link-local hosts are permitted (blocking off). */
  allowPrivate: boolean;
  /** Explicitly permitted hosts (`host` or `host:port`, lower-cased). */
  allowList:    Set<string>;
}

/** Parse a comma/newline-separated allowlist string into a normalized set. */
export function parseAllowList(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Build the default policy from environment variables (blocking ON by default). */
export function ssrfPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SsrfPolicy {
  const allowPrivate = /^(1|true|yes|on)$/i.test((env.SSRF_ALLOW_PRIVATE ?? '').trim());
  return { allowPrivate, allowList: parseAllowList(env.SSRF_ALLOWLIST) };
}

function ipv4Private(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const oct = parts.map((p) => Number(p));
  if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = oct;
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function ipv6Private(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;              // loopback / unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped IPv6
  if (mapped) return ipv4Private(mapped[1]);
  return false;
}

/**
 * True if a hostname points somewhere only reachable from inside the deployment:
 * a private/loopback/link-local IP literal, or a loopback-style name.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return ipv6Private(host);
  return ipv4Private(host);
}

/**
 * Validate an outbound URL against SSRF policy: enforce http(s), then reject
 * private/internal hosts unless blocking is disabled or the host is allowlisted.
 * Returns the parsed URL so callers can reuse it.
 */
export function assertSafeUrl(raw: string, policy: SsrfPolicy): URL {
  const u = assertHttpUrl(raw);
  if (policy.allowPrivate) return u;

  const host     = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = u.port ? `${host}:${u.port}` : host;
  if (policy.allowList.has(host) || policy.allowList.has(hostPort)) return u;

  if (isPrivateHost(host)) {
    throw new Error(
      `Blocked private/internal host "${host}" (SSRF protection). Add it to the ` +
      `SSRF allowlist to permit a local provider, or set SSRF_ALLOW_PRIVATE=true.`,
    );
  }
  return u;
}
