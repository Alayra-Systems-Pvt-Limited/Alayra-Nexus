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
set: vi.fn(async (k: string, v: string, ...opts: unknown[]) => {
      if (opts.includes('NX') && kv.has(k)) return null;
      kv.set(k, v); return 'OK';
    }),
  },
}));
vi.mock('./settings.service', () => ({ readSettingFresh: vi.fn(async () => setting.value) }));

import { loadRegistry, registryPrices, servableSnapshot } from './registrySnapshot';
import { normalizeModel, type AiModel } from './model.service';
import { REGISTRY_CACHE_KEY } from '../lib/registryCacheKey';
import { effectivePrice } from '../lib/routing';

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

  it('writes no shared copy from a read that a local update overtook', async () => {
    setting.value = stored('old');
    await loadRegistry(normalize, () => false);
    expect(kv.has(REGISTRY_CACHE_KEY)).toBe(false);
  });

  it('never replaces a shared copy another process wrote while this one was reading', async () => {
    const { readSettingFresh } = await import('./settings.service');
    vi.mocked(readSettingFresh).mockImplementationOnce(async () => {
      kv.set(REGISTRY_CACHE_KEY, stored('newer'));
      return stored('old');
    });
    await loadRegistry(normalize);
    expect(kv.get(REGISTRY_CACHE_KEY)).toBe(stored('newer'));
  });

  it('treats an unreadable shared copy as missing, and an unreadable setting as empty', async () => {
    kv.set(REGISTRY_CACHE_KEY, '{"not":"a list"}');
    setting.value = 'not json';
    expect(await loadRegistry(normalize)).toEqual([]);
  });
});

describe('derived lists', () => {
  const registry = (): AiModel[] => [
    normalizeModel({ id: 'a', modelString: 'a', provider: 'openai', inputCostPer1M: 2 }),
    normalizeModel({ id: 'b', modelString: 'b', provider: 'groq', status: 'paused' }),
    normalizeModel({ id: 'c', modelString: 'c', provider: 'groq' }),
  ];
  const toEntry = vi.fn((m: AiModel) => ({
    id: m.id, displayName: m.id, provider: m.provider, capabilities: m.capabilities, contextWindow: 0, maxTokens: 0, auto: false,
  }));

  it('prices each model once per registry version, exactly as routing would', () => {
    const one = registry();
    const prices = registryPrices(one);
    expect(registryPrices(one)).toBe(prices);
    for (const m of one) expect(prices.get(m.id)).toBe(effectivePrice(m as unknown as Record<string, unknown>));

    // A new version is a new array, and gets its own prices.
    expect(registryPrices(registry())).not.toBe(prices);
  });

  it('keeps active models with a pool, and rebuilds when the pools change', () => {
    const one = registry();
    const first = servableSnapshot(one, new Set(['openai', 'groq']), toEntry);
    expect(first.models.map((m) => m.id)).toEqual(['a', 'c']);
    expect(first.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(servableSnapshot(one, new Set(['groq', 'openai']), toEntry)).toBe(first);
    expect(toEntry).toHaveBeenCalledTimes(2);

    expect(servableSnapshot(one, new Set(['openai']), toEntry).models.map((m) => m.id)).toEqual(['a']);
  });
});
