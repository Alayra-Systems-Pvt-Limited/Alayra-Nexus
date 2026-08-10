import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify, SignJWT, generateKeyPair, exportJWK } from 'jose';

// ── The jose contract SSO actually depends on ─────────────────────────────────────────────────
//
// sso.service.test.ts does `vi.mock('jose', …)`, which is right for what it tests — the service's
// own branching, the nonce check, the role mapping — and it means that file would pass against a
// jose that had stopped verifying signatures at all. Every green tick on the 5→6 bump was earned
// against a stub.
//
// So this file runs the real library over real HTTP: a keypair is generated, its public half served
// as a JWKS from a local server, a token signed and then verified through the exact two calls
// sso.service makes — `createRemoteJWKSet(new URL(uri))` and `jwtVerify(token, jwks, { issuer,
// audience })`. Nothing is mocked.
//
// What it is for: this is the only signature check standing between an unauthenticated stranger and
// an owner account on a gateway with SSO enabled. jose 6 rewrote key handling — the resolved key is
// now normalised to a CryptoKey or Uint8Array — and removed algorithms. A regression here is not a
// failing request; it is a forged id_token being believed.

const ISSUER   = 'https://idp.test';
const AUDIENCE = 'nexus-client-id';

let server: Server;
let jwksUrl: URL;
let sign: (claims: Record<string, unknown>, overrides?: { iss?: string; aud?: string; expSec?: number }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`);

  sign = (claims, o = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${o.expSec ?? 300}s`)
    .sign(privateKey);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('verifying an ID token the way SSO does', () => {
  it('accepts a correctly signed token and returns its claims', async () => {
    const token = await sign({ sub: 'user-1', email: 'a@b.co', nonce: 'n1' });
    const { payload } = await jwtVerify(token, createRemoteJWKSet(jwksUrl), {
      issuer: ISSUER, audience: AUDIENCE,
    });
    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('a@b.co');
    // The service reads `nonce` off this payload and compares it to what it stored. If a jose
    // change ever dropped unknown claims, the nonce check would compare undefined to undefined.
    expect(payload.nonce).toBe('n1');
  });

  it('refuses a token signed by a key the JWKS does not publish', async () => {
    // The forgery case. An attacker who can mint tokens with their own key gets an owner account
    // if this ever stops holding.
    const { privateKey: attacker } = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({ sub: 'attacker' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('300s')
      .sign(attacker);
    await expect(jwtVerify(forged, createRemoteJWKSet(jwksUrl), { issuer: ISSUER, audience: AUDIENCE }))
      .rejects.toThrow();
  });

  it('refuses a token from another issuer', async () => {
    const token = await sign({ sub: 'user-1' }, { iss: 'https://evil.test' });
    await expect(jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer: ISSUER, audience: AUDIENCE }))
      .rejects.toThrow();
  });

  it('refuses a token minted for a different client', async () => {
    const token = await sign({ sub: 'user-1' }, { aud: 'someone-elses-app' });
    await expect(jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer: ISSUER, audience: AUDIENCE }))
      .rejects.toThrow();
  });

  it('refuses an expired token', async () => {
    const token = await sign({ sub: 'user-1' }, { expSec: -10 });
    await expect(jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer: ISSUER, audience: AUDIENCE }))
      .rejects.toThrow();
  });

  it('refuses alg: none', async () => {
    // The classic JWT break. sso.service's comment claims jose rejects it by default; nothing in
    // the repository checked that claim until now.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.`
      + `${Buffer.from(JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE })).toString('base64url')}.`;
    await expect(jwtVerify(unsigned, createRemoteJWKSet(jwksUrl), { issuer: ISSUER, audience: AUDIENCE }))
      .rejects.toThrow();
  });
});
