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

// Enterprise SSO pure core (Phase 6.6): the parts of an OIDC Authorization-Code + PKCE
// sign-in that involve no I/O — one-time secret generation, the authorize-URL builder,
// scope normalization, and the claim → Nexus-role mapping. All deterministic given their
// inputs (secret generation aside) and unit-tested, so the network-facing service layer
// stays thin. No token verification lives here: that is delegated wholesale to `jose`.

import { randomBytes, createHash } from 'crypto';
import type { AdminRole } from '../services/adminAuth.service';

/** A high-entropy opaque value: the `state` CSRF token and the `nonce` replay guard. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * A PKCE pair (RFC 7636, S256). The `verifier` is held server-side for the token
 * exchange; only its SHA-256 `challenge` travels to the IdP, so an intercepted
 * authorization code cannot be redeemed without the verifier.
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier  = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Normalize a space-separated scope string: trim, dedupe, and guarantee `openid`
 * leads — without it the IdP will not return an ID token and the sign-in cannot
 * complete. Falls back to a sane default when the operator left it blank.
 */
export function normalizeScopes(raw: string | null | undefined): string {
  const parts = (raw ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>(['openid']);
  for (const p of parts) seen.add(p);
  const rest = [...seen].filter((s) => s !== 'openid');
  return ['openid', ...rest].join(' ');
}

export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId:      string;
  redirectUri:   string;
  scopes:        string;
  state:         string;
  nonce:         string;
  codeChallenge: string;
}

/**
 * Build the IdP authorize URL for an Authorization-Code + PKCE flow. Query values are
 * set through `URLSearchParams`, so every value is encoded exactly once and no operator
 * input can break out of its parameter.
 */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const u = new URL(p.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', normalizeScopes(p.scopes));
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** The two fields of the SSO config that drive role assignment. */
export interface RoleMapping {
  roleClaim:  string;
  ownerValue: string;
}

/**
 * Map verified ID-token claims onto a Nexus role. Least-privilege by construction:
 * a caller is granted `owner` ONLY when the configured claim carries the configured
 * value (matched against a string claim or any member of an array claim). Everyone
 * else who authenticates — and every login while the mapping is unconfigured — is a
 * read-only `viewer`. The master password stays the owner break-glass, so a mapping
 * mistake degrades access rather than removing it.
 */
export function mapClaimToRole(
  claims: Record<string, unknown>,
  mapping: RoleMapping,
): AdminRole {
  const claim = mapping.roleClaim.trim();
  const owner = mapping.ownerValue.trim();
  if (!claim || !owner) return 'viewer';

  const raw = claims[claim];
  const values = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : raw === undefined || raw === null
      ? []
      : [String(raw)];

  return values.includes(owner) ? 'owner' : 'viewer';
}
