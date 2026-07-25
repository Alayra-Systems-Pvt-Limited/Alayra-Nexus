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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisMock, queryRaw } = vi.hoisted(() => ({
  redisMock: { ping: vi.fn(async () => 'PONG'), info: vi.fn(async () => 'redis_version:7.2.4\r\nused_memory:1000\r\nmaxmemory:0\r\nkeyspace_hits:90\r\nkeyspace_misses:10') },
  queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
}));
vi.mock('../lib/redis',  () => ({ redis: redisMock }));
vi.mock('../lib/prisma', () => ({ prisma: { $queryRaw: queryRaw } }));

import {
  takeSample, runReadyChecks, getHealthOverview, stopHealthSampler,
} from './healthSampler.service';

beforeEach(() => {
  redisMock.ping.mockClear();
  redisMock.ping.mockResolvedValue('PONG');
  queryRaw.mockClear();
  queryRaw.mockResolvedValue([{ '?column?': 1 }] as never);
});

// The buffer is module state; every test starts from an empty hour.
afterEach(() => stopHealthSampler());

describe('takeSample', () => {
  it('records a healthy tick with measured round-trips', async () => {
    const s = await takeSample(1_000_000);
    expect(s.redisOk).toBe(true);
    expect(s.redisMs).toBeGreaterThanOrEqual(0);
    expect(s.pgOk).toBe(true);
    expect(s.pgMs).toBeGreaterThanOrEqual(0);
    expect(s.rssBytes).toBeGreaterThan(0);
  });

  it('a failed probe is a data point, not an exception', async () => {
    redisMock.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const s = await takeSample(1_000_000);
    expect(s.redisOk).toBe(false);
    expect(s.redisMs).toBeNull();
    expect(s.pgOk).toBe(true); // one dead dependency never blanks the other
  });
});

describe('runReadyChecks (GET /ready)', () => {
  it('is ready when every dependency answers', async () => {
    const r = await runReadyChecks();
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['redis', 'postgres', 'eventLoop', 'heap']);
  });

  it('refuses traffic when a dependency is down — the 503 a load balancer needs', async () => {
    queryRaw.mockRejectedValue(new Error('db gone'));
    const r = await runReadyChecks();
    expect(r.ready).toBe(false);
    expect(r.status).toBe('down');
    expect(r.checks.find((c) => c.id === 'postgres')!.status).toBe('down');
  });

  it('probes live rather than trusting a cached sample', async () => {
    await takeSample(1_000_000);           // healthy history…
    queryRaw.mockRejectedValue(new Error('db just died'));
    const r = await runReadyChecks();      // …must not hide a dependency that died since
    expect(r.ready).toBe(false);
  });
});

describe('getHealthOverview', () => {
  it('composes status, checks, history window and per-dependency detail', async () => {
    const NOW = Date.now();
    await takeSample(NOW - 30_000);
    await takeSample(NOW);
    // readPgStats issues several introspection queries; give them all a benign shape.
    queryRaw.mockResolvedValue([] as never);

    const o = await getHealthOverview(NOW);
    expect(o.status).toBe('healthy');
    expect(o.summary).toBe('All systems operational');
    expect(o.ready).toBe(true);
    expect(o.window.samples).toBe(2);
    expect(o.strip).toHaveLength(60);
    expect(o.strip.at(-1)).toBe('healthy');
    expect(o.redis.p50Ms).not.toBeNull();
    // maxmemory:0 in INFO = no limit set → null, so the UI shows no fake percentage.
    expect(o.redis.info?.maxMemoryBytes).toBeNull();
    expect(o.redis.hitRate).toBeCloseTo(0.9);
    expect(o.process.heapLimitBytes).toBeGreaterThan(0);
  });

  it('an empty buffer is an honest "no history yet", not a healthy-looking zero line', async () => {
    queryRaw.mockResolvedValue([] as never);
    const o = await getHealthOverview();
    expect(o.window.samples).toBe(0);
    expect(o.sampledAt).toBeNull();
    expect(o.strip.every((c) => c === 'none')).toBe(true);
    expect(o.series).toEqual([]);
    // With no sample, the probes have not answered — the page must say down/collecting, not healthy.
    expect(o.status).toBe('down');
  });

  it('a Postgres that refuses introspection still yields a panel, with nulls for the absent facts', async () => {
    const NOW = Date.now();
    await takeSample(NOW);
    queryRaw.mockRejectedValue(new Error('permission denied for pg_stat_database'));
    const o = await getHealthOverview(NOW);
    expect(o.postgres.stats).not.toBeNull();
    expect(o.postgres.stats!.cacheHitRatio).toBeNull();
    expect(o.postgres.stats!.databaseBytes).toBeNull();
    expect(o.postgres.stats!.largestTables).toEqual([]);
  });

  it('survives Redis INFO being unavailable (a managed instance hiding it)', async () => {
    const NOW = Date.now();
    await takeSample(NOW);
    redisMock.info.mockRejectedValueOnce(new Error('NOPERM'));
    queryRaw.mockResolvedValue([] as never);
    const o = await getHealthOverview(NOW);
    expect(o.redis.info).toBeNull();
    expect(o.redis.up).toBe(true); // the PING still proved it alive
  });
});

// The `backend` block (S0). The Health page reads this to tell an operator which stores the gateway
// is on — a question they otherwise answer by guessing at environment variables. It is also the one
// part of the overview derived from configuration rather than measurement, so it is worth asserting
// that it reports the environment truthfully instead of a hardcoded pair.
describe('getHealthOverview — backend block', () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
    // readPgStats runs several introspection queries; an empty result is the benign shape for all.
    queryRaw.mockResolvedValue([] as never);
  });
  afterEach(() => { process.env = ENV; });

  it('reports Postgres + Redis and no caution when both are configured', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/d';
    process.env.REDIS_URL    = 'redis://h:6379';
    delete process.env.NEXUS_MODE;

    const { backend } = await getHealthOverview();
    expect(backend).toMatchObject({
      mode: 'server', db: 'postgres', kv: 'redis',
      dbLabel: 'PostgreSQL', kvLabel: 'Redis',
      durable: true, summary: 'PostgreSQL + Redis', warning: null,
    });
  });

  it('reports an in-memory KV as not durable, with the reason', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/d';
    delete process.env.REDIS_URL;
    delete process.env.NEXUS_MODE;

    const { backend } = await getHealthOverview();
    expect(backend.kv).toBe('memory');
    expect(backend.durable).toBe(false);
    expect(backend.warning).toMatch(/signed out/i);
  });

  it('carries labels the dashboard can print without knowing any engine names', async () => {
    process.env.DATABASE_URL = 'file:./nexus.db';
    delete process.env.REDIS_URL;
    delete process.env.NEXUS_MODE;

    const { backend } = await getHealthOverview();
    expect(backend.dbLabel).toBe('SQLite');
    expect(backend.kvLabel).toBe('In-process memory');
    expect(backend.summary).toContain('not durable');
  });
});

// Found while writing the backend-block tests: readPgStats read `versionRow[0]?.v.match(...)`, which
// guards a missing ROW but not a null COLUMN — so a version() answering with an unexpected shape
// crashed the entire Health response instead of degrading to "version —".
describe('getHealthOverview — malformed introspection rows', () => {
  it('survives a version row whose column is null', async () => {
    queryRaw.mockResolvedValue([{ v: null }] as never);
    const o = await getHealthOverview();
    expect(o.postgres.stats?.version).toBeNull();
    expect(o.status).toBeDefined();
  });

  it('survives a version row missing the column entirely', async () => {
    queryRaw.mockResolvedValue([{ somethingElse: 1 }] as never);
    const o = await getHealthOverview();
    expect(o.postgres.stats?.version).toBeNull();
  });
});
