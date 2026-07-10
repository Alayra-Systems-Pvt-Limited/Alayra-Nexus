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

// Importing model.service pulls in the prisma and redis clients; stub them so the
// pure normalizeModel logic can be exercised without a database.
import { vi } from 'vitest';
vi.mock('../lib/prisma', () => ({ prisma: {} }));
vi.mock('../lib/redis',  () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));

import { normalizeModel } from './model.service';

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
