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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted so the vi.mock factories below (which are hoisted above imports) can close over them.
const { prismaMock, redisMock, joseMock, ssrfMock, sessionMock } = vi.hoisted(() => ({
  prismaMock:  { ssoProvider: { findUnique: vi.fn(), upsert: vi.fn() } },
  redisMock:   { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  joseMock:    { jwtVerify: vi.fn(), createRemoteJWKSet: vi.fn(() => 'JWKS') },
  ssrfMock:    { getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) },
  sessionMock: { createSession: vi.fn(async (role: string) => ({ token: `sess-${role}`, expiresIn: 43200 })) },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../lib/redis',  () => ({ redis: redisMock }));
vi.mock('jose', () => ({ jwtVerify: joseMock.jwtVerify, createRemoteJWKSet: joseMock.createRemoteJWKSet }));
// Reversible stand-ins so a test can assert the secret was wrapped and unwrapped.
vi.mock('../lib/encryption', () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => s.replace(/^ENC:/, ''),
}));
vi.mock('./ssrf.service', () => ({ getSsrfPolicy: ssrfMock.getSsrfPolicy }));
vi.mock('./adminAuth.service', () => ({ createSession: sessionMock.createSession }));

import * as sso from './sso.service';

const ISSUER = 'https://idp.example.com';
const DISCOVERY = {
  issuer:                 ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint:         `${ISSUER}/token`,
  jwks_uri:               `${ISSUER}/jwks`,
};

function enabledRow(over: Record<string, unknown> = {}) {
  return {
    id: 'singleton', protocol: 'oidc', enabled: true,
    displayName: 'Acme SSO', issuer: ISSUER, clientId: 'client-abc',
    clientSecret: 'ENC:s3cret', scopes: 'openid email', roleClaim: 'groups',
    ownerValue: 'nexus-admins', ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  ssrfMock.getSsrfPolicy.mockResolvedValue({ allowPrivate: true, allowList: new Set<string>() });
  sessionMock.createSession.mockImplementation(async (role: string) => ({ token: `sess-${role}`, expiresIn: 43200 }));
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('getLoginHint', () => {
  it('offers SSO only when enabled and fully configured', async () => {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow());
    expect(await sso.getLoginHint()).toEqual({ enabled: true, displayName: 'Acme SSO' });
  });
  it('does not offer SSO when disabled or missing', async () => {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow({ enabled: false }));
    expect((await sso.getLoginHint()).enabled).toBe(false);
    prismaMock.ssoProvider.findUnique.mockResolvedValue(null);
    expect((await sso.getLoginHint()).enabled).toBe(false);
  });
});

describe('getPublicConfig', () => {
  it('reports whether a secret is set but never returns it', async () => {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow());
    const cfg = await sso.getPublicConfig();
    expect(cfg.hasSecret).toBe(true);
    expect(cfg.callbackPath).toBe('/admin/sso/callback');
    expect(cfg).not.toHaveProperty('clientSecret');
  });
});

describe('saveConfig', () => {
  it('encrypts a new secret and normalizes scopes', async () => {
    prismaMock.ssoProvider.upsert.mockResolvedValue({});
    await sso.saveConfig({
      enabled: true, displayName: 'Acme', issuer: `${ISSUER}/`, clientId: 'cid',
      clientSecret: 'topsecret', scopes: 'email profile', roleClaim: 'groups', ownerValue: 'admins',
    });
    const arg = prismaMock.ssoProvider.upsert.mock.calls[0][0];
    expect(arg.update.clientSecret).toBe('ENC:topsecret');
    expect(arg.update.issuer).toBe(ISSUER);               // trailing slash stripped
    expect(arg.update.scopes).toBe('openid email profile'); // openid guaranteed to lead
  });

  it('keeps the stored secret when none is supplied', async () => {
    prismaMock.ssoProvider.upsert.mockResolvedValue({});
    await sso.saveConfig({
      enabled: true, displayName: 'Acme', issuer: ISSUER, clientId: 'cid',
      clientSecret: '', scopes: 'openid', roleClaim: '', ownerValue: '',
    });
    expect(prismaMock.ssoProvider.upsert.mock.calls[0][0].update).not.toHaveProperty('clientSecret');
  });

  it('rejects enabling without an issuer', async () => {
    await expect(sso.saveConfig({
      enabled: true, displayName: '', issuer: '', clientId: 'cid',
      scopes: 'openid', roleClaim: '', ownerValue: '',
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an internal issuer under SSRF policy', async () => {
    ssrfMock.getSsrfPolicy.mockResolvedValue({ allowPrivate: false, allowList: new Set<string>() });
    await expect(sso.saveConfig({
      enabled: true, displayName: '', issuer: 'http://localhost:8080', clientId: 'cid',
      scopes: 'openid', roleClaim: '', ownerValue: '',
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('beginLogin', () => {
  it('discovers the IdP, stores one-time state, and returns the authorize URL', async () => {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow());
    redisMock.get.mockResolvedValue(null); // discovery not cached → fetch it
    fetchMock.mockResolvedValue({ ok: true, json: async () => DISCOVERY });

    const url = await sso.beginLogin('https://nexus.example.com/admin/sso/callback');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get('client_id')).toBe('client-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');

    const stateWrite = redisMock.set.mock.calls.find((c) => String(c[0]).startsWith('nexus:sso:state:'));
    expect(stateWrite).toBeTruthy();
    const pending = JSON.parse(stateWrite![1]);
    expect(pending).toHaveProperty('nonce');
    expect(pending).toHaveProperty('verifier');
    expect(pending.redirectUri).toBe('https://nexus.example.com/admin/sso/callback');
    // the state key must match the state in the URL, and it must carry a TTL
    expect(String(stateWrite![0])).toBe(`nexus:sso:state:${u.searchParams.get('state')}`);
    expect(stateWrite![2]).toBe('EX');
  });

  it('refuses to start when SSO is not enabled', async () => {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow({ enabled: false }));
    await expect(sso.beginLogin('https://nexus.example.com/admin/sso/callback'))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('completeLogin', () => {
  const PENDING = JSON.stringify({ nonce: 'nonce-1', verifier: 'verifier-1', redirectUri: 'https://nexus.example.com/admin/sso/callback' });

  function primeState() {
    prismaMock.ssoProvider.findUnique.mockResolvedValue(enabledRow());
    redisMock.get.mockImplementation(async (key: string) => {
      if (key.startsWith('nexus:sso:state:'))     return PENDING;
      if (key.startsWith('nexus:sso:discovery:'))  return JSON.stringify(DISCOVERY);
      return null;
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id_token: 'idtok', access_token: 'a' }) });
  }

  it('maps an owner group to an owner session and redeems the code once', async () => {
    primeState();
    joseMock.jwtVerify.mockResolvedValue({ payload: { nonce: 'nonce-1', groups: ['nexus-admins'], sub: 'u1' } });

    const out = await sso.completeLogin('auth-code', 'state-xyz');
    expect(out).toEqual({ token: 'sess-owner', role: 'owner', expiresIn: 43200 });
    expect(sessionMock.createSession).toHaveBeenCalledWith('owner');
    // single use: the state is consumed before the exchange
    expect(redisMock.del).toHaveBeenCalledWith('nexus:sso:state:state-xyz');
    // the exchange carried the PKCE verifier and the client secret
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('code_verifier=verifier-1');
    expect(body).toContain('client_secret=s3cret');
    expect(body).toContain('grant_type=authorization_code');
  });

  it('maps a non-owner identity to a read-only viewer session', async () => {
    primeState();
    joseMock.jwtVerify.mockResolvedValue({ payload: { nonce: 'nonce-1', groups: ['engineering'], sub: 'u2' } });
    const out = await sso.completeLogin('auth-code', 'state-xyz');
    expect(out.role).toBe('viewer');
    expect(sessionMock.createSession).toHaveBeenCalledWith('viewer');
  });

  it('refuses a replayed or expired state', async () => {
    redisMock.get.mockResolvedValue(null);
    await expect(sso.completeLogin('auth-code', 'state-xyz')).rejects.toMatchObject({ code: 'state_expired' });
  });

  it('refuses a token response with no id_token', async () => {
    primeState();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'a' }) });
    await expect(sso.completeLogin('auth-code', 'state-xyz')).rejects.toMatchObject({ code: 'no_id_token' });
  });

  it('refuses a mismatched nonce (replay of another handshake)', async () => {
    primeState();
    joseMock.jwtVerify.mockResolvedValue({ payload: { nonce: 'WRONG', groups: ['nexus-admins'] } });
    await expect(sso.completeLogin('auth-code', 'state-xyz')).rejects.toMatchObject({ code: 'verification_failed' });
  });

  it('surfaces a signature/issuer/audience failure as verification_failed', async () => {
    primeState();
    joseMock.jwtVerify.mockRejectedValue(new Error('unexpected "iss" claim value'));
    await expect(sso.completeLogin('auth-code', 'state-xyz')).rejects.toMatchObject({ code: 'verification_failed' });
  });
});
