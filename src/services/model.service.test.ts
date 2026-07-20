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

import { describe, it, expect, beforeEach } from 'vitest';

// Importing model.service pulls in the prisma and redis clients; stub them so the
// pure normalizeModel logic can be exercised without a database.
import { vi } from 'vitest';

// The registry lives in AppSettings; back it with an in-memory string so the read/modify/write
// helpers can be exercised end to end. redis.get returns undefined → every read misses the cache
// and falls through to this store, which is what makes the writes observable.
const { store } = vi.hoisted(() => ({ store: { value: '[]' } }));
vi.mock('../lib/prisma', () => ({ prisma: {} }));
vi.mock('../lib/redis',  () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('./settings.service', () => ({
  getSetting: vi.fn(async () => store.value),
  setSetting: vi.fn(async (_k: string, v: string) => { store.value = v; }),
}));

import { normalizeModel, removeModelById, removeModelsForProvider, getModelRegistry } from './model.service';

const seed = (models: Record<string, unknown>[]) => { store.value = JSON.stringify(models); };
const model = (id: string, provider: string) => ({ id, modelString: id, provider, displayName: id });

describe('normalizeModel — registry migration (Phase 6.1)', () => {
  it('gives every model at least the chat capability', () => {
    expect(normalizeModel({ id: 'm', modelString: 'x', provider: 'openai' }).capabilities).toEqual(['chat']);
  });

  it('grants completion to a legacy FIM model, on top of chat', () => {
    const caps = normalizeModel({ id: 'm', modelString: 'x', hasFIM: true }).capabilities;
    expect(caps).toContain('chat');
    expect(caps).toContain('completion');
  });

  it('preserves explicit capabilities and drops unknown ones', () => {
    const caps = normalizeModel({ id: 'm', modelString: 'x', capabilities: ['embedding', 'bogus', 'image'] }).capabilities;
    expect(caps).toEqual(['embedding', 'image']);
  });

  it('maps the legacy supports* flags onto the current feature flags', () => {
    const m = normalizeModel({ id: 'm', modelString: 'x', supportsVision: true, supportsToolCalling: true });
    expect(m.hasVision).toBe(true);
    expect(m.hasToolCalling).toBe(true);
  });

  it('converts legacy per-1k pricing to per-1M', () => {
    const m = normalizeModel({ id: 'm', modelString: 'x', inputPricePer1k: 0.003, outputPricePer1k: 0.015 });
    expect(m.inputCostPer1M).toBeCloseTo(3);
    expect(m.outputCostPer1M).toBeCloseTo(15);
  });

  it('keeps per-1M pricing when already present', () => {
    const m = normalizeModel({ id: 'm', modelString: 'x', inputCostPer1M: 2.5, outputCostPer1M: 10 });
    expect(m.inputCostPer1M).toBe(2.5);
    expect(m.outputCostPer1M).toBe(10);
  });

  it('defaults tier to standard and status to active', () => {
    const m = normalizeModel({ id: 'm', modelString: 'x' });
    expect(m.tier).toBe('standard');
    expect(m.status).toBe('active');
  });

  it('derives priority from tier when absent', () => {
    expect(normalizeModel({ id: 'm', modelString: 'x', tier: 'premium' }).priority).toBe(1);
    expect(normalizeModel({ id: 'm', modelString: 'x', tier: 'fast' }).priority).toBe(3);
  });

  it('falls back the id to the model string when id is missing', () => {
    expect(normalizeModel({ modelString: 'gpt-4o' }).id).toBe('gpt-4o');
  });
});

describe('removeModelById (Phase 7.17b)', () => {
  beforeEach(() => { store.value = '[]'; });

  it('removes exactly the named model and reports it', async () => {
    seed([model('a', 'openai'), model('b', 'openrouter')]);
    expect(await removeModelById('a')).toBe(true);
    expect((await getModelRegistry()).map((m) => m.id)).toEqual(['b']);
  });

  it('reports false for an id that is not there, so the route can 404 honestly', async () => {
    seed([model('a', 'openai')]);
    expect(await removeModelById('nope')).toBe(false);
    expect((await getModelRegistry())).toHaveLength(1);
  });
});

describe('removeModelsForProvider (Phase 7.17b)', () => {
  beforeEach(() => { store.value = '[]'; });

  it('drops only the models of the named provider, and counts them', async () => {
    // The bug this exists for: deleting a pool used to leave its models behind, so they reappeared
    // the moment a pool of the same provider was created again.
    seed([
      model('or-1', 'openrouter'), model('or-2', 'openrouter'),
      model('oa-1', 'openai'),
    ]);
    expect(await removeModelsForProvider('openrouter')).toBe(2);
    expect((await getModelRegistry()).map((m) => m.id)).toEqual(['oa-1']);
  });

  it('is a no-op for a provider with nothing registered', async () => {
    seed([model('oa-1', 'openai')]);
    expect(await removeModelsForProvider('groq')).toBe(0);
    expect((await getModelRegistry())).toHaveLength(1);
  });
});
