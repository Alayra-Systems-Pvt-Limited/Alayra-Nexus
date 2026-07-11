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

// Enterprise SSO service (Phase 6.6): the network-facing half of an OIDC
// Authorization-Code + PKCE sign-in. It configures a single identity provider, discovers
// its endpoints, drives the redirect handshake, verifies the returned ID token, and — on
// success — mints an ordinary Nexus admin session at the mapped role. Nothing here is a
// new session model: verification ends at `createSession(role)`, the same primitive the
// password and token paths use, so RBAC, lockout, and TTL all apply unchanged.
//
// Every trust boundary reuses an existing guard: `assertSafeUrl` (SSRF) gates every
// outbound URL, `encrypt`/`decrypt` wrap the client secret in the same AES-256-GCM
// envelope as provider keys, and `jose` — not hand-rolled crypto — verifies the ID token
// signature, issuer, audience, and expiry against the IdP's published JWKS.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { prisma }        from '../lib/prisma';
import { redis }         from '../lib/redis';
import { encrypt, decrypt } from '../lib/encryption';
import { assertSafeUrl, stripTrailingSlash } from '../lib/url';
import { getSsrfPolicy } from './ssrf.service';
import { createSession, type AdminRole } from './adminAuth.service';
import { randomToken, generatePkce, buildAuthorizeUrl, normalizeScopes, mapClaimToRole } from '../lib/sso';

const SINGLETON = 'singleton';

/** Where the IdP sends the user back. Registered at the IdP; must match on both legs. */
export const SSO_CALLBACK_PATH = '/admin/sso/callback';

const STATE_PREFIX     = 'nexus:sso:state:';
const DISCOVERY_PREFIX = 'nexus:sso:discovery:';
const STATE_TTL_SECONDS     = 600;   // a login handshake must complete within 10 minutes
const DISCOVERY_TTL_SECONDS = 3600;  // IdP metadata is stable; refresh hourly
const HTTP_TIMEOUT_MS       = 8000;

// ── Typed failures ──────────────────────────────────────────────────────────────
// Every reason a sign-in can fail carries a stable code the route turns into a neutral
// message. No IdP response body or internal detail is ever surfaced to the browser.

export type SsoErrorCode =
  | 'not_configured'
  | 'discovery_failed'
  | 'invalid_request'
  | 'state_expired'
  | 'token_exchange_failed'
  | 'no_id_token'
  | 'verification_failed';

export class SsoError extends Error {
  constructor(public code: SsoErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SsoError';
  }
}

// ── Configuration ────────────────────────────────────────────────────────────────

export interface SsoConfigInput {
  enabled:      boolean;
  displayName:  string;
  issuer:       string;
  clientId:     string;
  /** New secret to store. Empty/undefined keeps the existing one, so the UI never has
   *  to round-trip the secret back to the browser to save an unrelated change. */
  clientSecret?: string;
  scopes:       string;
  roleClaim:    string;
  ownerValue:   string;
}

/** The config as the dashboard may see it — the secret is never included, only whether one is set. */
export interface SsoPublicConfig {
  protocol:     string;
  enabled:      boolean;
  displayName:  string;
  issuer:       string;
  clientId:     string;
  scopes:       string;
  roleClaim:    string;
  ownerValue:   string;
  hasSecret:    boolean;
  callbackPath: string;
}

interface SsoResolved {
  enabled:      boolean;
  displayName:  string;
  issuer:       string;
  clientId:     string;
  clientSecret: string; // decrypted, '' when unset
  scopes:       string;
  roleClaim:    string;
  ownerValue:   string;
}

async function getRow() {
  return prisma.ssoProvider.findUnique({ where: { id: SINGLETON } });
}

/** Internal view with the secret decrypted for the token exchange. */
async function resolveConfig(): Promise<SsoResolved | null> {
  const row = await getRow();
  if (!row) return null;
  return {
    enabled:      row.enabled,
    displayName:  row.displayName,
    issuer:       stripTrailingSlash(row.issuer.trim()),
    clientId:     row.clientId.trim(),
    clientSecret: row.clientSecret ? decrypt(row.clientSecret) : '',
    scopes:       row.scopes,
    roleClaim:    row.roleClaim,
    ownerValue:   row.ownerValue,
  };
}

/** The safe, secret-free config for the dashboard. Absent row → sensible disabled defaults. */
export async function getPublicConfig(): Promise<SsoPublicConfig> {
  const row = await getRow();
  return {
    protocol:     row?.protocol ?? 'oidc',
    enabled:      row?.enabled ?? false,
    displayName:  row?.displayName ?? 'Single Sign-On',
    issuer:       row?.issuer ?? '',
    clientId:     row?.clientId ?? '',
    scopes:       row?.scopes ?? 'openid email profile',
    roleClaim:    row?.roleClaim ?? '',
    ownerValue:   row?.ownerValue ?? '',
    hasSecret:    !!row?.clientSecret,
    callbackPath: SSO_CALLBACK_PATH,
  };
}

/** What the unauthenticated login screen may know: only whether to offer the button. */
export async function getLoginHint(): Promise<{ enabled: boolean; displayName: string }> {
  const row = await getRow();
  const configured = !!row?.enabled && !!row.issuer && !!row.clientId;
  return { enabled: configured, displayName: row?.displayName ?? 'Single Sign-On' };
}

/**
 * Persist the config. The issuer is validated against the SSRF policy before it is
 * stored, so an internal-only address is rejected at write time rather than at login.
 * An empty `clientSecret` leaves the stored one untouched; a non-empty one replaces it.
 */
export async function saveConfig(input: SsoConfigInput): Promise<void> {
  const issuer = stripTrailingSlash(input.issuer.trim());
  if (input.enabled) {
    if (!issuer || !input.clientId.trim()) {
      throw new SsoError('invalid_request', 'issuer and clientId are required to enable SSO.');
    }
    // Reject an unreachable/internal issuer up front (SSRF); scheme + host checked.
    try {
      assertSafeUrl(issuer, await getSsrfPolicy());
    } catch (e) {
      throw new SsoError('invalid_request', e instanceof Error ? e.message : 'invalid issuer URL');
    }
  }

  const secretUpdate = input.clientSecret && input.clientSecret.trim()
    ? { clientSecret: encrypt(input.clientSecret.trim()) }
    : {};

  const data = {
    enabled:     input.enabled,
    displayName: input.displayName.trim() || 'Single Sign-On',
    issuer,
    clientId:    input.clientId.trim(),
    scopes:      normalizeScopes(input.scopes),
    roleClaim:   input.roleClaim.trim(),
    ownerValue:  input.ownerValue.trim(),
    ...secretUpdate,
  };

  await prisma.ssoProvider.upsert({
    where:  { id: SINGLETON },
    create: { id: SINGLETON, protocol: 'oidc', ...data },
    update: data,
  });
}

// ── OIDC discovery ───────────────────────────────────────────────────────────────

interface Discovery {
  issuer:                 string;
  authorization_endpoint: string;
  token_endpoint:         string;
  jwks_uri:               string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new SsoError('token_exchange_failed', `HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/**
 * Fetch and validate the IdP's OpenID configuration, caching it for an hour. The
 * discovery URL and every endpoint it returns are SSRF-checked before use, and the
 * document's `issuer` must equal the configured one — the OIDC mix-up defence.
 */
async function discover(issuer: string): Promise<Discovery> {
  const cached = await redis.get(DISCOVERY_PREFIX + issuer).catch(() => null);
  if (cached) { try { return JSON.parse(cached) as Discovery; } catch { /* refetch */ } }

  const policy = await getSsrfPolicy();
  const wellKnown = `${stripTrailingSlash(issuer)}/.well-known/openid-configuration`;
  assertSafeUrl(wellKnown, policy);

  let doc: Record<string, unknown>;
  try {
    const res = await fetch(wellKnown, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new SsoError('discovery_failed', e instanceof Error ? e.message : 'discovery fetch failed');
  }

  const disc: Discovery = {
    issuer:                 String(doc.issuer ?? ''),
    authorization_endpoint: String(doc.authorization_endpoint ?? ''),
    token_endpoint:         String(doc.token_endpoint ?? ''),
    jwks_uri:               String(doc.jwks_uri ?? ''),
  };
  if (disc.issuer !== issuer) {
    throw new SsoError('discovery_failed', 'issuer mismatch between configuration and discovery document');
  }
  for (const url of [disc.authorization_endpoint, disc.token_endpoint, disc.jwks_uri]) {
    if (!url) throw new SsoError('discovery_failed', 'discovery document is missing a required endpoint');
    assertSafeUrl(url, policy); // SSRF: an IdP must not steer us at an internal host
  }

  await redis.set(DISCOVERY_PREFIX + issuer, JSON.stringify(disc), 'EX', DISCOVERY_TTL_SECONDS).catch(() => {});
  return disc;
}

// One remote key set per JWKS URI. `jose` fetches lazily and caches with rotation, so a
// key roll at the IdP is picked up without a restart.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(jwksUri);
  if (!set) { set = createRemoteJWKSet(new URL(jwksUri)); jwksCache.set(jwksUri, set); }
  return set;
}

// ── The handshake ────────────────────────────────────────────────────────────────

interface PendingLogin { nonce: string; verifier: string; redirectUri: string }

/**
 * Begin a sign-in: discover the IdP, mint the one-time `state`/`nonce`/PKCE values, stash
 * the secret half server-side keyed by `state`, and return the authorize URL to redirect to.
 * The `redirectUri` is bound into the stored state so the callback redeems the code against
 * the exact value the IdP saw.
 */
export async function beginLogin(redirectUri: string): Promise<string> {
  const cfg = await resolveConfig();
  if (!cfg || !cfg.enabled || !cfg.issuer || !cfg.clientId) throw new SsoError('not_configured');

  const disc  = await discover(cfg.issuer);
  const state = randomToken();
  const nonce = randomToken();
  const pkce  = generatePkce();

  const pending: PendingLogin = { nonce, verifier: pkce.verifier, redirectUri };
  await redis.set(STATE_PREFIX + state, JSON.stringify(pending), 'EX', STATE_TTL_SECONDS);

  return buildAuthorizeUrl({
    authorizationEndpoint: disc.authorization_endpoint,
    clientId:      cfg.clientId,
    redirectUri,
    scopes:        cfg.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });
}

/**
 * Complete a sign-in from the IdP callback. Consumes the `state` (single use — replay is
 * refused), redeems the code with the PKCE verifier, verifies the ID token's signature,
 * issuer, audience, and expiry with `jose`, checks the `nonce`, maps the claims to a role,
 * and mints a session. Returns the bearer token for the dashboard to store.
 */
export async function completeLogin(code: string, state: string): Promise<{ token: string; role: AdminRole; expiresIn: number }> {
  if (!code || !state) throw new SsoError('invalid_request');

  const raw = await redis.get(STATE_PREFIX + state);
  if (!raw) throw new SsoError('state_expired');
  await redis.del(STATE_PREFIX + state); // single use: consume before doing anything with it

  let pending: PendingLogin;
  try { pending = JSON.parse(raw) as PendingLogin; } catch { throw new SsoError('invalid_request'); }

  const cfg = await resolveConfig();
  if (!cfg || !cfg.enabled) throw new SsoError('not_configured');
  const disc = await discover(cfg.issuer);

  // Redeem the authorization code. PKCE proves this is the same agent that began the flow;
  // the client secret (when the IdP issued one) is sent via client_secret_post.
  const form = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  pending.redirectUri,
    client_id:     cfg.clientId,
    code_verifier: pending.verifier,
  });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);

  assertSafeUrl(disc.token_endpoint, await getSsrfPolicy());
  const tokenResp = (await fetchJson(disc.token_endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body:    form.toString(),
  })) as { id_token?: string };

  if (!tokenResp.id_token) throw new SsoError('no_id_token');

  // Verify the ID token: signature against the published JWKS, issuer and audience bound,
  // expiry enforced. `jose` rejects `alg: none` and unlisted algorithms by default.
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokenResp.id_token, jwksFor(disc.jwks_uri), {
      issuer:   disc.issuer,
      audience: cfg.clientId,
    }));
  } catch (e) {
    throw new SsoError('verification_failed', e instanceof Error ? e.message : 'ID token verification failed');
  }

  if (!payload.nonce || payload.nonce !== pending.nonce) {
    throw new SsoError('verification_failed', 'nonce mismatch');
  }

  const role = mapClaimToRole(payload as Record<string, unknown>, {
    roleClaim:  cfg.roleClaim,
    ownerValue: cfg.ownerValue,
  });
  const session = await createSession(role);
  return { token: session.token, role, expiresIn: session.expiresIn };
}
