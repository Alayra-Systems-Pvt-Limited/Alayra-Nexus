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

// ── Gateway health: the pure core (Phase 7.12) ───────────────────────────────
// Everything here is deterministic and I/O-free: the sample ring buffer, percentiles, the
// Redis INFO parser, threshold verdicts, the per-minute status strip, and the cgroup memory-limit
// parser. The side effects — actually probing Redis/Postgres, timing the event loop, scheduling —
// live in healthSampler.service. Splitting it this way is what makes every number on the Health
// page unit-testable without a running dependency.

// ── Status model ──────────────────────────────────────────────────────────────
// Three states, never colour-alone in the UI: healthy (within threshold), degraded (probe answered
// but above threshold — still serving), down (probe failed). Overall status is the worst dependency.

export type HealthStatus = 'healthy' | 'degraded' | 'down';

const RANK: Record<HealthStatus, number> = { healthy: 0, degraded: 1, down: 2 };

export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'healthy');
}

/** Verdict for one probe: failed → down; answered but over its threshold → degraded. */
export function probeStatus(ok: boolean, measuredMs: number | null, thresholdMs: number): HealthStatus {
  if (!ok || measuredMs === null) return 'down';
  return measuredMs > thresholdMs ? 'degraded' : 'healthy';
}

// Thresholds a probe is judged against. Deliberately generous: this page flags real trouble, not
// noise — a 60ms Redis ping is unusual but not an incident.
export const THRESHOLDS = {
  redisPingMs:   50,
  postgresMs:    150,
  eventLoopP99Ms: 200,
  heapPct:       90,
} as const;

// ── Percentiles ───────────────────────────────────────────────────────────────

/** Nearest-rank percentile over a copy of `values`; null when there is nothing to rank. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ── Sample ring buffer ────────────────────────────────────────────────────────
// One entry per sampler tick. A fixed-size ring rather than an array that grows: an hour at 15s is
// 240 entries of small numbers — a few KB, immune to leaks, and deliberately in-memory only. History
// resets with the process, and the UI says so ("collecting — full picture in an hour") instead of
// pretending continuity it does not have.

export interface HealthSample {
  ts:          number;         // epoch ms
  redisOk:     boolean;
  redisMs:     number | null;  // PING round-trip; null when the probe failed
  pgOk:        boolean;
  pgMs:        number | null;  // SELECT 1 round-trip
  loopP50Ms:   number;         // event-loop delay percentiles over the tick window
  loopP99Ms:   number;
  cpuPct:      number;         // process CPU over the tick window, 0–100 (may exceed 100 on multi-core)
  rssBytes:    number;
  heapUsedBytes: number;
}

export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('RingBuffer capacity must be >= 1');
  }
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  /** Oldest → newest. A copy, so a caller can never corrupt the buffer. */
  values(): T[] { return [...this.buf]; }
  get length(): number { return this.buf.length; }
  clear(): void { this.buf = []; }
}

// ── Per-minute status strip ───────────────────────────────────────────────────
// The status-page pattern: one cell per minute, coloured by the worst sample inside it. Minutes with
// no samples (before the process started, or a stalled sampler) are 'none' — an honest gap, not a
// green one.

export type StripCell = HealthStatus | 'none';

export function sampleStatus(s: HealthSample): HealthStatus {
  return worstStatus([
    probeStatus(s.redisOk, s.redisMs, THRESHOLDS.redisPingMs),
    probeStatus(s.pgOk, s.pgMs, THRESHOLDS.postgresMs),
    s.loopP99Ms > THRESHOLDS.eventLoopP99Ms ? 'degraded' : 'healthy',
  ]);
}

/** The last `minutes` minutes ending at `now`, oldest first. */
export function minuteStrip(samples: HealthSample[], minutes: number, now: number): StripCell[] {
  const cells: StripCell[] = new Array(minutes).fill('none');
  for (const s of samples) {
    const age = Math.floor((now - s.ts) / 60_000);
    if (age < 0 || age >= minutes) continue;
    const i = minutes - 1 - age;
    const st = sampleStatus(s);
    if (cells[i] === 'none' || RANK[st] > RANK[cells[i] as HealthStatus]) cells[i] = st;
  }
  return cells;
}

/** Per-minute aggregates for the sparklines: latency maxima (spikes must show, an average would
 *  flatter them away), last RSS. Only minutes that have samples are returned. */
export interface MinutePoint {
  ts: number; redisMs: number | null; pgMs: number | null;
  cpuPct: number; rssMb: number; loopP99Ms: number;
}

export function minuteSeries(samples: HealthSample[], minutes: number, now: number): MinutePoint[] {
  const byMinute = new Map<number, HealthSample[]>();
  for (const s of samples) {
    const age = Math.floor((now - s.ts) / 60_000);
    if (age < 0 || age >= minutes) continue;
    const bucket = now - age * 60_000;
    const arr = byMinute.get(bucket);
    if (arr) arr.push(s); else byMinute.set(bucket, [s]);
  }
  const maxOrNull = (vals: (number | null)[]): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length ? Math.max(...nums) : null;
  };
  return [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, arr]) => ({
      ts,
      redisMs:   maxOrNull(arr.map((s) => s.redisMs)),
      pgMs:      maxOrNull(arr.map((s) => s.pgMs)),
      cpuPct:    Math.max(...arr.map((s) => s.cpuPct)),
      rssMb:     Math.round(arr[arr.length - 1].rssBytes / 1048576),
      loopP99Ms: Math.max(...arr.map((s) => s.loopP99Ms)),
    }));
}

// ── Redis INFO parser ─────────────────────────────────────────────────────────
// INFO is line-oriented `key:value` with `# Section` headers and CRLF endings. Only the fields the
// Health page shows are pulled out; anything absent (a managed Redis that hides sections) is null
// rather than zero — "unknown" and "0" are different facts.

export interface RedisInfoStats {
  version:            string | null;
  uptimeSeconds:      number | null;
  connectedClients:   number | null;
  blockedClients:     number | null;
  usedMemoryBytes:    number | null;
  maxMemoryBytes:     number | null;   // 0 in Redis means "no limit" → null here
  fragmentationRatio: number | null;
  opsPerSec:          number | null;
  keyspaceHits:       number | null;
  keyspaceMisses:     number | null;
  evictedKeys:        number | null;
  expiredKeys:        number | null;
}

export function parseRedisInfo(info: string): RedisInfoStats {
  const map = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
  }
  const num = (k: string): number | null => {
    const v = map.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const maxMemory = num('maxmemory');
  return {
    version:            map.get('redis_version') ?? null,
    uptimeSeconds:      num('uptime_in_seconds'),
    connectedClients:   num('connected_clients'),
    blockedClients:     num('blocked_clients'),
    usedMemoryBytes:    num('used_memory'),
    maxMemoryBytes:     maxMemory === null || maxMemory <= 0 ? null : maxMemory,
    fragmentationRatio: num('mem_fragmentation_ratio'),
    opsPerSec:          num('instantaneous_ops_per_sec'),
    keyspaceHits:       num('keyspace_hits'),
    keyspaceMisses:     num('keyspace_misses'),
    evictedKeys:        num('evicted_keys'),
    expiredKeys:        num('expired_keys'),
  };
}

/** Hit rate over hits+misses; null (not 100%) when there has been no traffic to measure. */
export function hitRate(hits: number | null, misses: number | null): number | null {
  if (hits === null || misses === null) return null;
  const total = hits + misses;
  return total > 0 ? hits / total : null;
}

// ── cgroup memory limit ───────────────────────────────────────────────────────
// Inside a container, Node's os.totalmem() reports the HOST's RAM — a "% of RAM" gauge built on it
// would be a lie. The container's real ceiling lives in the cgroup filesystem. v2 writes "max" (and
// v1 writes a huge sentinel) for "no limit"; both parse to null, and the UI then shows no container
// gauge rather than a fake one.

const CGROUP_NO_LIMIT_SENTINEL = 2 ** 60; // v1 reports ~9.2e18 when unlimited

export function parseCgroupLimit(raw: string | null): number | null {
  if (raw === null) return null;
  const v = raw.trim();
  if (v === '' || v === 'max') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= CGROUP_NO_LIMIT_SENTINEL) return null;
  return n;
}

// ── Readiness checks ──────────────────────────────────────────────────────────
// The exact checks GET /ready runs, in the shape the dashboard renders — one truth for the load
// balancer and the Health page.

export interface ReadyCheck {
  id:        'redis' | 'postgres' | 'eventLoop' | 'heap';
  label:     string;
  measured:  string;         // human-readable measured value
  threshold: string;
  status:    HealthStatus;
}

export function evaluateChecks(args: {
  redisOk: boolean; redisMs: number | null;
  pgOk: boolean; pgMs: number | null;
  loopP99Ms: number;
  heapUsedBytes: number; heapLimitBytes: number;
  /**
   * What the KV actually is (S1). Left undefined the label stays "Redis PING", which is what every
   * caller before standalone mode meant. With in-process counters there is no Redis to ping, and a
   * check confidently reporting on one would be reporting on nothing — /ready is read by
   * orchestrators, so a label there has to name the thing that was really probed.
   */
  kvLabel?: string;
}): ReadyCheck[] {
  const heapPct = args.heapLimitBytes > 0 ? (args.heapUsedBytes / args.heapLimitBytes) * 100 : 0;
  const ms = (v: number | null) => (v === null ? 'no response' : `${v.toFixed(1)} ms`);
  const kvCheckLabel = args.kvLabel && args.kvLabel !== 'Redis' ? `${args.kvLabel} read` : 'Redis PING';
  return [
    {
      id: 'redis', label: kvCheckLabel,
      measured: ms(args.redisMs), threshold: `< ${THRESHOLDS.redisPingMs} ms`,
      status: probeStatus(args.redisOk, args.redisMs, THRESHOLDS.redisPingMs),
    },
    {
      id: 'postgres', label: 'Postgres SELECT 1',
      measured: ms(args.pgMs), threshold: `< ${THRESHOLDS.postgresMs} ms`,
      status: probeStatus(args.pgOk, args.pgMs, THRESHOLDS.postgresMs),
    },
    {
      id: 'eventLoop', label: 'Event-loop lag p99',
      measured: `${args.loopP99Ms.toFixed(1)} ms`, threshold: `< ${THRESHOLDS.eventLoopP99Ms} ms`,
      status: args.loopP99Ms > THRESHOLDS.eventLoopP99Ms ? 'degraded' : 'healthy',
    },
    {
      id: 'heap', label: 'Heap saturation',
      measured: `${heapPct.toFixed(0)}%`, threshold: `< ${THRESHOLDS.heapPct}%`,
      status: heapPct > THRESHOLDS.heapPct ? 'degraded' : 'healthy',
    },
  ];
}

/** One plain sentence for the banner. Names the worst problem; never a vague "issues detected". */
export function summarize(checks: ReadyCheck[]): { status: HealthStatus; summary: string } {
  const status = worstStatus(checks.map((c) => c.status));
  if (status === 'healthy') return { status, summary: 'All systems operational' };
  const bad = checks.filter((c) => c.status !== 'healthy');
  const healthyDeps = checks.filter((c) => c.status === 'healthy').length;
  const first = bad[0];
  const verb = first.status === 'down' ? 'is not responding' : 'above threshold';
  const head = first.id === 'eventLoop' ? `Event-loop lag ${verb}`
    : first.id === 'heap' ? `Heap usage ${verb}`
    : first.id === 'redis' ? (first.status === 'down' ? 'Redis is not responding' : 'Redis latency above threshold')
    : (first.status === 'down' ? 'PostgreSQL is not responding' : 'PostgreSQL query latency above threshold');
  return { status, summary: `${head} · ${healthyDeps} of ${checks.length} checks healthy` };
}
