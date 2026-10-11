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

// `lib/redis` as a host sees it (P0.5b): importing it opens nothing, the open-source default still
// follows REDIS_URL, and a host's client installed with configureCoreKv() replaces it entirely.
// Each test re-imports the module so its first-use choice starts fresh.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const created: { on: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }[] = [];
vi.mock('./redisClient', () => ({
  createRedisClient: vi.fn(() => {
    const client = { on: vi.fn(), get: vi.fn(async () => 'from-env-redis') };
    created.push(client);
    return client;
  }),
}));

async function freshRedisModule(redisUrl: string | undefined) {
  vi.resetModules();
  if (redisUrl === undefined) vi.stubEnv('REDIS_URL', '');
  else vi.stubEnv('REDIS_URL', redisUrl);
  return import('./redis');
}

beforeEach(() => { created.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('lib/redis — the open-source default', () => {
  it('opens no connection at import, and one on first use', async () => {
    const mod = await freshRedisModule('redis://localhost:6379');
    expect(created).toHaveLength(0);

    await expect(mod.redis.get('k')).resolves.toBe('from-env-redis');
    expect(created).toHaveLength(1);
    expect(created[0].on).toHaveBeenCalledWith('error', expect.any(Function));   // our collapsed log
    expect(mod.usingMemoryKv()).toBe(false);
  });

  it('falls back to the in-process store with no REDIS_URL', async () => {
    const mod = await freshRedisModule(undefined);
    await mod.redis.set('k', 'v');
    await expect(mod.redis.get('k')).resolves.toBe('v');
    expect(mod.usingMemoryKv()).toBe(true);
    expect(created).toHaveLength(0);
  });
});

describe('lib/redis — a host-installed client', () => {
  it('is used instead of REDIS_URL, and is left to the host for logging', async () => {
    const mod = await freshRedisModule('redis://localhost:6379');
    const host = { on: vi.fn(), get: vi.fn(async () => 'from-host') };
    mod.configureCoreKv(host as never);

    await expect(mod.redis.get('k')).resolves.toBe('from-host');
    expect(created).toHaveLength(0);
    expect(host.on).not.toHaveBeenCalled();
    expect(mod.usingMemoryKv()).toBe(false);
  });

  it('is refused once the core has already used a store', async () => {
    const mod = await freshRedisModule(undefined);
    await mod.redis.get('k');
    expect(() => mod.configureCoreKv({} as never)).toThrow(/configureCoreKv\(\) once, at boot/);
  });

  it('is what the core entry exports', async () => {
    vi.resetModules();
    const [core, redis] = await Promise.all([import('../core'), import('./redis')]);
    expect(core.configureCoreKv).toBe(redis.configureCoreKv);
  });
});
