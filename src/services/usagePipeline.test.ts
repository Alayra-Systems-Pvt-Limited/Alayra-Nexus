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

import { describe, it, expect, vi } from 'vitest';

// The module imports the Prisma client at load; mock it so no DB client spins up.
// Every test injects its own `insert`, so the default sink is never exercised here.
vi.mock('../lib/prisma', () => ({ prisma: { tokenUsage: { createMany: vi.fn() } } }));

import { createUsagePipeline, type UsageEvent } from './usagePipeline';

let seq = 0;
const evt = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id:             `id-${seq++}`,
  sessionId:      's', modelId: 'm', modelName: 'm', provider: 'p',
  inputTokens:    10, outputTokens: 5, totalTokens: 15, estimatedUsd: 0.001,
  nexusTeamKeyId: null, createdAt: new Date(),
  ...over,
});

describe('usage pipeline buffering', () => {
  it('buffers events and flushes them as one batch', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false, maxBatch: 1000 });
    p.emit(evt()); p.emit(evt());
    expect(p.size()).toBe(2);
    expect(insert).not.toHaveBeenCalled(); // nothing written yet

    const n = await p.flush();
    expect(n).toBe(2);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
    expect(p.size()).toBe(0);
  });

  it('flushes automatically once the size threshold is reached', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false, maxBatch: 3 });
    p.emit(evt()); p.emit(evt());
    expect(insert).not.toHaveBeenCalled();
    p.emit(evt()); // hits threshold → triggers flush
    await Promise.resolve(); await Promise.resolve();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('is a no-op flush when the buffer is empty', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false });
    expect(await p.flush()).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('usage pipeline resilience', () => {
  it('re-queues the batch when the sink fails (no data loss)', async () => {
    const insert = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false, maxBatch: 1000 });
    p.emit(evt()); p.emit(evt());

    expect(await p.flush()).toBe(0);   // failed
    expect(p.size()).toBe(2);          // events retained, not lost

    expect(await p.flush()).toBe(2);   // retry succeeds
    expect(p.size()).toBe(0);
  });

  it('sheds load past the cap to bound memory, counting drops', () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false, maxBatch: 1000, cap: 2 });
    p.emit(evt()); p.emit(evt()); p.emit(evt()); p.emit(evt());
    expect(p.size()).toBe(2);
    expect(p.dropped()).toBe(2);
  });

  it('drain flushes remaining events and stops', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const p = createUsagePipeline({ insert, autoStart: false, maxBatch: 1000 });
    p.emit(evt()); p.emit(evt());
    await p.drain();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(p.size()).toBe(0);
  });
});
