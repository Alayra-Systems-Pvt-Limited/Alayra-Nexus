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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kv, setting } = vi.hoisted(() => ({ kv: new Map<string, string>(), setting: { value: null as string | null } }));

vi.mock('../lib/redis', () => ({
  redis: {
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
  },
}));
vi.mock('./settings.service', () => ({ readSettingFresh: vi.fn(async () => setting.value) }));

import { loadRegistry } from './registrySnapshot';
import { normalizeModel } from './model.service';
import { REGISTRY_CACHE_KEY } from '../lib/registryCacheKey';

const normalize = vi.fn(normalizeModel);
const stored = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id, modelString: id, provider: 'openai', inputCostPer1M: 1 })));

beforeEach(() => {
  kv.clear();
  setting.value = null;
  normalize.mockClear();
});

describe('loadRegistry', () => {
  it('builds the shared copy from the setting once, and never parses that copy back', async () => {
    setting.value = stored('a', 'b');
    const first = await loadRegistry(normalize);
    expect(first.map((m) => m.id)).toEqual(['a', 'b']);
    expect(kv.get(REGISTRY_CACHE_KEY)).toBe(JSON.stringify(first));
    expect(normalize).toHaveBeenCalledTimes(2);

    // Every later read finds the shared copy this process wrote: same text, so no work at all.
    for (let i = 0; i < 5; i++) expect(await loadRegistry(normalize)).toBe(first);
    expect(normalize).toHaveBeenCalledTimes(2);
  });

  it('parses a shared copy written by another process, once per distinct text', async () => {
    kv.set(REGISTRY_CACHE_KEY, stored('x'));
    const first = await loadRegistry(normalize);
    kv.set(REGISTRY_CACHE_KEY, stored('x'));
    expect(await loadRegistry(normalize)).toBe(first);
    expect(normalize).toHaveBeenCalledTimes(1);

    kv.set(REGISTRY_CACHE_KEY, stored('x', 'y'));
    expect((await loadRegistry(normalize)).map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('rebuilds the shared copy from an unchanged setting without parsing it again', async () => {
    setting.value = stored('a');
    const first = await loadRegistry(normalize);
    kv.delete(REGISTRY_CACHE_KEY); // the shared copy expired
    expect(await loadRegistry(normalize)).toBe(first);
    expect(kv.get(REGISTRY_CACHE_KEY)).toBe(JSON.stringify(first));
    expect(normalize).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable shared copy as missing, and an unreadable setting as empty', async () => {
    kv.set(REGISTRY_CACHE_KEY, '{"not":"a list"}');
    setting.value = 'not json';
    expect(await loadRegistry(normalize)).toEqual([]);
  });
});
