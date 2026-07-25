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
import {
  worstStatus, probeStatus, percentile, RingBuffer, minuteStrip, minuteSeries,
  parseRedisInfo, hitRate, parseCgroupLimit, evaluateChecks, summarize, sampleStatus,
  THRESHOLDS, type HealthSample,
} from './health';

const sample = (over: Partial<HealthSample> = {}): HealthSample => ({
  ts: 1_000_000, redisOk: true, redisMs: 0.5, pgOk: true, pgMs: 12,
  loopP50Ms: 1, loopP99Ms: 4, cpuPct: 3, rssBytes: 200 * 1048576, heapUsedBytes: 100 * 1048576,
  ...over,
});

describe('status model', () => {
  it('overall status is the worst dependency', () => {
    expect(worstStatus(['healthy', 'healthy'])).toBe('healthy');
    expect(worstStatus(['healthy', 'degraded'])).toBe('degraded');
    expect(worstStatus(['degraded', 'down', 'healthy'])).toBe('down');
    expect(worstStatus([])).toBe('healthy');
  });

  it('a probe over its threshold is degraded — still serving, not down', () => {
    expect(probeStatus(true, 10, 50)).toBe('healthy');
    expect(probeStatus(true, 51, 50)).toBe('degraded');
    expect(probeStatus(false, null, 50)).toBe('down');
    expect(probeStatus(true, null, 50)).toBe('down'); // answered without a measurement = not answered
  });
});

describe('percentile', () => {
  it('nearest-rank percentiles', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 99)).toBe(10);
  });
  it('null for an empty set — never a fake 0', () => {
    expect(percentile([], 50)).toBeNull();
  });
  it('does not mutate its input', () => {
    const v = [3, 1, 2];
    percentile(v, 50);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('RingBuffer', () => {
  it('caps at capacity, dropping the oldest', () => {
    const b = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => b.push(n));
    expect(b.values()).toEqual([3, 4, 5]);
    expect(b.length).toBe(3);
  });
  it('values() returns a copy the caller cannot corrupt', () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.values().push(99);
    expect(b.values()).toEqual([1]);
  });
});

describe('minuteStrip', () => {
  const NOW = 10 * 60_000; // t = 10 minutes

  it('colours each minute by its worst sample and leaves empty minutes as honest gaps', () => {
    const samples = [
      sample({ ts: NOW - 30_000 }),                                    // age 0: healthy
      sample({ ts: NOW - 90_000, pgMs: 500 }),                         // age 1: degraded (pg slow)
      sample({ ts: NOW - 100_000 }),                                   // age 1 too, healthy — worst wins
      sample({ ts: NOW - 150_000, redisOk: false, redisMs: null }),    // age 2: down
    ];
    const strip = minuteStrip(samples, 5, NOW);
    expect(strip).toEqual(['none', 'none', 'down', 'degraded', 'healthy']);
  });

  it('ignores samples outside the window', () => {
    const strip = minuteStrip([sample({ ts: NOW - 60 * 60_000 })], 5, NOW);
    expect(strip).toEqual(['none', 'none', 'none', 'none', 'none']);
  });
});

describe('minuteSeries', () => {
  it('aggregates each minute with maxima, so a spike cannot be averaged away', () => {
    const NOW = 5 * 60_000;
    const pts = minuteSeries([
      sample({ ts: NOW - 65_000, pgMs: 10, cpuPct: 2 }),
      sample({ ts: NOW - 70_000, pgMs: 400, cpuPct: 60 }), // the spike, same minute
      sample({ ts: NOW - 5_000, pgMs: 12, cpuPct: 3 }),
    ], 5, NOW);
    expect(pts).toHaveLength(2);
    expect(pts[0].pgMs).toBe(400);
    expect(pts[0].cpuPct).toBe(60);
    expect(pts[1].pgMs).toBe(12);
  });

  it('a minute where every probe failed reports null latency, not zero', () => {
    const NOW = 120_000;
    const pts = minuteSeries([sample({ ts: NOW - 10_000, redisOk: false, redisMs: null })], 2, NOW);
    expect(pts[0].redisMs).toBeNull();
  });
});

describe('parseRedisInfo', () => {
  const INFO = [
    '# Server', 'redis_version:7.2.4', 'uptime_in_seconds:1060000',
    '# Clients', 'connected_clients:12', 'blocked_clients:0',
    '# Memory', 'used_memory:432013312', 'maxmemory:1073741824', 'mem_fragmentation_ratio:1.08',
    '# Stats', 'instantaneous_ops_per_sec:1240', 'keyspace_hits:2100000', 'keyspace_misses:27000',
    'evicted_keys:0', 'expired_keys:18200',
  ].join('\r\n');

  it('extracts the fields the Health page shows', () => {
    const s = parseRedisInfo(INFO);
    expect(s.version).toBe('7.2.4');
    expect(s.connectedClients).toBe(12);
    expect(s.usedMemoryBytes).toBe(432013312);
    expect(s.maxMemoryBytes).toBe(1073741824);
    expect(s.fragmentationRatio).toBe(1.08);
    expect(s.opsPerSec).toBe(1240);
    expect(s.evictedKeys).toBe(0);
  });

  it('maxmemory 0 means "no limit set" and becomes null — a % against it would be invented', () => {
    expect(parseRedisInfo('maxmemory:0').maxMemoryBytes).toBeNull();
  });

  it('missing fields are null, not zero — unknown and 0 are different facts', () => {
    const s = parseRedisInfo('# Server\r\nredis_version:7.0.0');
    expect(s.connectedClients).toBeNull();
    expect(s.usedMemoryBytes).toBeNull();
    expect(s.evictedKeys).toBeNull();
  });
});

describe('hitRate', () => {
  it('hits over hits+misses', () => expect(hitRate(90, 10)).toBeCloseTo(0.9));
  it('null with no traffic — reporting 100% would flatter an idle cache', () => {
    expect(hitRate(0, 0)).toBeNull();
    expect(hitRate(null, 5)).toBeNull();
  });
});

describe('parseCgroupLimit', () => {
  it('parses a real v2 limit', () => expect(parseCgroupLimit('536870912\n')).toBe(536870912));
  it('v2 "max" and the v1 unlimited sentinel both mean no limit', () => {
    expect(parseCgroupLimit('max')).toBeNull();
    expect(parseCgroupLimit('9223372036854771712')).toBeNull();
  });
  it('absent file or junk is no limit, never a crash', () => {
    expect(parseCgroupLimit(null)).toBeNull();
    expect(parseCgroupLimit('garbage')).toBeNull();
    expect(parseCgroupLimit('-5')).toBeNull();
  });
});

describe('evaluateChecks + summarize', () => {
  const healthyArgs = {
    redisOk: true, redisMs: 0.4, pgOk: true, pgMs: 12,
    loopP99Ms: 7, heapUsedBytes: 180 * 1048576, heapLimitBytes: 512 * 1048576,
  };

  it('all healthy → "All systems operational"', () => {
    const checks = evaluateChecks(healthyArgs);
    expect(checks.every((c) => c.status === 'healthy')).toBe(true);
    expect(summarize(checks)).toEqual({ status: 'healthy', summary: 'All systems operational' });
  });

  it('a slow Postgres degrades and is named in the banner', () => {
    const checks = evaluateChecks({ ...healthyArgs, pgMs: 184 });
    const pg = checks.find((c) => c.id === 'postgres')!;
    expect(pg.status).toBe('degraded');
    expect(pg.measured).toBe('184.0 ms');
    const s = summarize(checks);
    expect(s.status).toBe('degraded');
    expect(s.summary).toContain('PostgreSQL query latency above threshold');
    expect(s.summary).toContain('3 of 4 checks healthy');
  });

  it('a dead Redis is down and says "not responding", not "slow"', () => {
    const checks = evaluateChecks({ ...healthyArgs, redisOk: false, redisMs: null });
    expect(checks.find((c) => c.id === 'redis')!.status).toBe('down');
    expect(summarize(checks).summary).toContain('Redis is not responding');
  });

  it('heap saturation trips at the threshold', () => {
    const checks = evaluateChecks({ ...healthyArgs, heapUsedBytes: 470 * 1048576 });
    expect(checks.find((c) => c.id === 'heap')!.status).toBe('degraded'); // 92%
  });
});

describe('sampleStatus', () => {
  it('rolls one sample up to its worst probe', () => {
    expect(sampleStatus(sample())).toBe('healthy');
    expect(sampleStatus(sample({ pgMs: THRESHOLDS.postgresMs + 1 }))).toBe('degraded');
    expect(sampleStatus(sample({ redisOk: false, redisMs: null }))).toBe('down');
  });
});

// The readiness labels name the stores actually probed (S1 for the KV, S2.3 for the database).
// /ready is read by orchestrators and by humans during an incident; a label there that names an
// engine the gateway is not running is worse than no label at all.
describe('evaluateChecks — labels name what was really probed', () => {
  const base = {
    redisOk: true, redisMs: 1, pgOk: true, pgMs: 5,
    loopP99Ms: 2, heapUsedBytes: 10, heapLimitBytes: 100,
  };
  const labelOf = (checks: ReturnType<typeof evaluateChecks>, id: string) =>
    checks.find((c) => c.id === id)!.label;

  it('keeps the historical labels when no engine is named', () => {
    // Every caller before standalone mode passed neither, and must be unaffected.
    const c = evaluateChecks(base);
    expect(labelOf(c, 'redis')).toBe('Redis PING');
    expect(labelOf(c, 'postgres')).toBe('Postgres SELECT 1');
  });

  it('keeps them when the engines ARE the historical ones', () => {
    const c = evaluateChecks({ ...base, kvLabel: 'Redis', dbLabel: 'PostgreSQL' });
    expect(labelOf(c, 'redis')).toBe('Redis PING');
    expect(labelOf(c, 'postgres')).toBe('Postgres SELECT 1');
  });

  it('names the durable store when it is not PostgreSQL', () => {
    // The bug S1 left behind: a SQLite gateway reported "Postgres SELECT 1" to every orchestrator.
    const c = evaluateChecks({ ...base, dbLabel: 'SQLite' });
    expect(labelOf(c, 'postgres')).toBe('SQLite SELECT 1');
    expect(labelOf(c, 'postgres')).not.toMatch(/postgres/i);
  });

  it('names the KV store when it is not Redis', () => {
    const c = evaluateChecks({ ...base, kvLabel: 'In-process memory' });
    expect(labelOf(c, 'redis')).toBe('In-process memory read');
    expect(labelOf(c, 'redis')).not.toMatch(/redis/i);
  });

  it('names both at once on a fully standalone gateway', () => {
    const c = evaluateChecks({ ...base, kvLabel: 'In-process memory', dbLabel: 'SQLite' });
    expect(c.map((x) => x.label)).toEqual([
      'In-process memory read', 'SQLite SELECT 1', 'Event-loop lag p99', 'Heap saturation',
    ]);
    // And the ids never change — the UI and /ready consumers key off those, not the labels.
    expect(c.map((x) => x.id)).toEqual(['redis', 'postgres', 'eventLoop', 'heap']);
  });
});
