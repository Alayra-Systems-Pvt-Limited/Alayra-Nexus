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

// ── The key cipher port (P1.1, #196) ──────────────────────────────────────────────────────────
// The default opens keys the open-source way; a host installs its own once, at boot, and the
// request path then opens every key through it with the key's id and owner.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { configureCoreCipher, coreCipher, resetCoreCipherForTests } from './cipher';
import type { KeyCipher, KeyCipherContext } from './ports';
import { encrypt } from '../lib/encryption';
import { buildRoute } from '../services/routing/route';
import type { ProviderRow } from './ports';

const POOL: ProviderRow = {
  id: 'pool-1', baseUrl: 'https://api.example.test/v1', provider: 'openai', authHeader: 'Authorization',
  authPrefix: 'Bearer ', tier: 'standard', preferredModel: null, extraHeaders: null,
};
const MODEL = { modelString: 'gpt-x', modelId: 'gpt-x', tier: 'standard' };
const key = (over: Partial<Parameters<typeof buildRoute>[0]> = {}) => ({
  id: 'key-1', encryptedKey: 'vault:key-1', ownerTeamId: 'team-a', status: 'active', rpmLimit: 60, tpmLimit: 1000, ...over,
});

afterEach(() => resetCoreCipherForTests());

describe('the default cipher', () => {
  it('opens keys sealed by the open-source gateway', () => {
    const sealed = encrypt('sk-test-default-cipher');
    expect(coreCipher().decrypt(sealed, { keyId: 'k', ownerTeamId: null })).toBe('sk-test-default-cipher');
  });

  it('is what buildRoute uses when the host installs nothing', () => {
    const route = buildRoute(key({ encryptedKey: encrypt('sk-test-route-1234') }), POOL, 'closed', MODEL);
    expect(route.decryptedKey).toBe('sk-test-route-1234');
    expect(route.keyMask.endsWith('1234')).toBe(true);
  });
});

describe('configureCoreCipher', () => {
  it('routes every key through the host cipher, with the key id and its owner', () => {
    const seen: [string, KeyCipherContext][] = [];
    configureCoreCipher({ decrypt: (c, ctx) => { seen.push([c, ctx]); return `plain-of-${ctx.keyId}`; } });

    const own    = buildRoute(key(), POOL, 'closed', MODEL);
    const shared = buildRoute(key({ id: 'key-2', encryptedKey: 'vault:key-2', ownerTeamId: null }), POOL, 'probe', MODEL);

    expect(own.decryptedKey).toBe('plain-of-key-1');
    expect(shared.decryptedKey).toBe('plain-of-key-2');
    expect(seen).toEqual([
      ['vault:key-1', { keyId: 'key-1', ownerTeamId: 'team-a' }],
      ['vault:key-2', { keyId: 'key-2', ownerTeamId: null }],
    ]);
  });

  it('a cipher that cannot open a key fails the route rather than sending a wrong credential', () => {
    configureCoreCipher({ decrypt: () => { throw new Error('tenant key mismatch'); } });
    expect(() => buildRoute(key(), POOL, 'closed', MODEL)).toThrow('tenant key mismatch');
  });

  it('may be installed only once', () => {
    const cipher: KeyCipher = { decrypt: () => 'x' };
    configureCoreCipher(cipher);
    expect(() => configureCoreCipher(cipher)).toThrow(/already in use: call configureCoreCipher\(\) once/);
    expect(coreCipher()).toBe(cipher);
  });

  it('may not be installed after the core has opened a key', () => {
    coreCipher();                                         // first use picks the default
    expect(() => configureCoreCipher({ decrypt: () => 'x' })).toThrow(/already in use/);
  });

  it('refuses something that is not a cipher', () => {
    expect(() => configureCoreCipher({} as KeyCipher)).toThrow(/decrypt\(ciphertext, context\)/);
    // …and a refused install leaves the slot free for a real one.
    configureCoreCipher({ decrypt: () => 'ok' });
    expect(coreCipher().decrypt('c', { keyId: 'k', ownerTeamId: null })).toBe('ok');
  });
});

describe('loading the core without MASTER_ENCRYPTION_KEY', { timeout: 30_000 }, () => {
  const saved = process.env.MASTER_ENCRYPTION_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = saved;
    vi.resetModules();
  });

  it('loads, and a host cipher opens keys with no master key anywhere', async () => {
    delete process.env.MASTER_ENCRYPTION_KEY;
    vi.resetModules();
    const core = await import('./index');
    expect(typeof core.configureCoreCipher).toBe('function');
    core.configureCoreCipher({ decrypt: (_c, ctx) => `plain-of-${ctx.keyId}` });
    const { buildRoute: freshBuildRoute } = await import('../services/routing/route');
    expect(freshBuildRoute(key(), POOL, 'closed', MODEL).decryptedKey).toBe('plain-of-key-1');
  });

  it('without a host cipher, the first key opened fails with the master-key message', async () => {
    delete process.env.MASTER_ENCRYPTION_KEY;
    vi.resetModules();
    await import('./index');
    const { buildRoute: freshBuildRoute } = await import('../services/routing/route');
    expect(() => freshBuildRoute(key(), POOL, 'closed', MODEL))
      .toThrow('CRITICAL FATAL: MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  });
});
