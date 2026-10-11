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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureCoreStores, resetCoreStoresForTests } from '../../core/stores';
import type { CoreStores, KeyCheck, ProviderCheck } from '../../core/ports';

// ── Operator checks read through the core ports ───────────────────────────────
// testKey, validateModel and fetchProviderModels used to query Prisma inline. They now ask the
// installed KeyStore / ProviderStore, so a hosted gateway answers them from its own vault. These
// pin what each check does with the port's answer: a missing row, a pool with no active key, and
// which key (typed or stored) and which URL reach the provider.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/safeFetch',   () => ({ safeFetch: fetchMock }));
vi.mock('../ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: false, allowList: new Set() })) }));
vi.mock('../../lib/encryption',  () => ({ decrypt: (s: string) => `plain(${s})` }));

import { fetchProviderModels, testKey, validateModel } from './providerAdmin';

const pool: ProviderCheck = {
  baseUrl: 'https://api.example.com/v1/', provider: 'openai', authHeader: 'Authorization', authPrefix: 'Bearer ',
  extraHeaders: null, modelFetchUrl: null, modelIdPath: 'data[].id', activeKey: 'cipher-1',
};

const keys      = { findForCheck: vi.fn<(id: string) => Promise<KeyCheck | null>>() };
const providers = { findForCheck: vi.fn<(id: string) => Promise<ProviderCheck | null>>() };

beforeEach(() => {
  fetchMock.mockReset();
  keys.findForCheck.mockReset();
  providers.findForCheck.mockReset();
  configureCoreStores(() => ({ keys, providers }) as unknown as CoreStores);
});
afterEach(() => resetCoreStoresForTests());

/** The URL and auth header of the one provider call a check made. */
function lastCall(): { url: string; auth: string | undefined } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [URL, { headers: Record<string, string> }];
  return { url: url.toString(), auth: init.headers.Authorization };
}

describe('testKey', () => {
  it('reports a key the store no longer has', async () => {
    keys.findForCheck.mockResolvedValue(null);
    expect(await testKey('gone')).toEqual({ success: false, error: 'Key not found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the pool /models with the decrypted key', async () => {
    keys.findForCheck.mockResolvedValue({ encryptedKey: 'cipher-k', provider: pool });
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await testKey('k1')).success).toBe(true);
    expect(keys.findForCheck).toHaveBeenCalledWith('k1');
    expect(lastCall()).toEqual({ url: 'https://api.example.com/v1/models', auth: 'Bearer plain(cipher-k)' });
  });
});

describe('validateModel', () => {
  it('reports a pool the store no longer has', async () => {
    providers.findForCheck.mockResolvedValue(null);
    expect(await validateModel('p0', 'm')).toEqual({ ok: false, latencyMs: 0, error: 'Provider not found' });
  });

  it('refuses a pool with no active key without calling the provider', async () => {
    providers.findForCheck.mockResolvedValue({ ...pool, activeKey: null });
    const result = await validateModel('p1', 'm');
    expect(result.error).toMatch(/No active key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a one-token completion with the pool key', async () => {
    providers.findForCheck.mockResolvedValue(pool);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await validateModel('p1', 'gpt-x')).ok).toBe(true);
    expect(lastCall()).toEqual({ url: 'https://api.example.com/v1/chat/completions', auth: 'Bearer plain(cipher-1)' });
  });
});

describe('fetchProviderModels', () => {
  it('prefers a typed key over the stored one', async () => {
    providers.findForCheck.mockResolvedValue(pool);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }));
    const result = await fetchProviderModels('p1', '  sk-typed  ');
    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(['m1']);
    expect(lastCall().auth).toBe('Bearer sk-typed');
  });

  it('needs a typed key when the pool has no active one', async () => {
    providers.findForCheck.mockResolvedValue({ ...pool, activeKey: null });
    const result = await fetchProviderModels('p1');
    expect(result.error).toMatch(/Enter an API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the pool model-fetch URL and id path when set', async () => {
    providers.findForCheck.mockResolvedValue({ ...pool, modelFetchUrl: 'https://catalog.example.com/list', modelIdPath: 'models[].name' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }), { status: 200 }));
    const result = await fetchProviderModels('p1');
    expect(result.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(lastCall()).toEqual({ url: 'https://catalog.example.com/list', auth: 'Bearer plain(cipher-1)' });
  });
});
