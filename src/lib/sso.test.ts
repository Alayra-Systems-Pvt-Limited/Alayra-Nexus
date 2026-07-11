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
import { createHash } from 'crypto';
import { randomToken, generatePkce, normalizeScopes, buildAuthorizeUrl, mapClaimToRole } from './sso';

describe('randomToken', () => {
  it('is high-entropy hex and unique per call', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('generatePkce', () => {
  it('derives the challenge as the base64url SHA-256 of the verifier (RFC 7636 S256)', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);           // base64url, no padding
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('produces a fresh pair each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe('normalizeScopes', () => {
  it('guarantees openid leads', () => {
    expect(normalizeScopes('email profile')).toBe('openid email profile');
  });
  it('keeps a valid list intact', () => {
    expect(normalizeScopes('openid email')).toBe('openid email');
  });
  it('dedupes and defaults a blank value to openid', () => {
    expect(normalizeScopes('openid openid email')).toBe('openid email');
    expect(normalizeScopes('')).toBe('openid');
    expect(normalizeScopes(null)).toBe('openid');
  });
});

describe('buildAuthorizeUrl', () => {
  it('sets an Authorization-Code + PKCE (S256) query, encoded exactly once', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      clientId:      'client-123',
      redirectUri:   'https://nexus.example.com/admin/sso/callback',
      scopes:        'profile',
      state:         'st-abc',
      nonce:         'nn-xyz',
      codeChallenge: 'chal',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example.com/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('client-123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://nexus.example.com/admin/sso/callback');
    expect(u.searchParams.get('scope')).toBe('openid profile');
    expect(u.searchParams.get('state')).toBe('st-abc');
    expect(u.searchParams.get('nonce')).toBe('nn-xyz');
    expect(u.searchParams.get('code_challenge')).toBe('chal');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('mapClaimToRole', () => {
  const mapping = { roleClaim: 'groups', ownerValue: 'nexus-admins' };

  it('grants owner when an array claim contains the owner value', () => {
    expect(mapClaimToRole({ groups: ['dev', 'nexus-admins'] }, mapping)).toBe('owner');
  });
  it('grants owner when a string claim equals the owner value', () => {
    expect(mapClaimToRole({ groups: 'nexus-admins' }, mapping)).toBe('owner');
  });
  it('falls back to viewer when the claim is absent or unmatched', () => {
    expect(mapClaimToRole({ groups: ['dev'] }, mapping)).toBe('viewer');
    expect(mapClaimToRole({}, mapping)).toBe('viewer');
  });
  it('is least-privilege when the mapping is unconfigured', () => {
    expect(mapClaimToRole({ groups: ['anything'] }, { roleClaim: '', ownerValue: '' })).toBe('viewer');
    expect(mapClaimToRole({ groups: ['anything'] }, { roleClaim: 'groups', ownerValue: '' })).toBe('viewer');
  });
});
