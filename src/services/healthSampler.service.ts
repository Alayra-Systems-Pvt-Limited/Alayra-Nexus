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

// ── Gateway health: sampling + the overview read (Phase 7.12) ────────────────
// The side-effect half of the Health page. Every 15 seconds this probes Redis (PING) and Postgres
// (SELECT 1), reads the event-loop delay histogram and process counters, and pushes one small
// sample into an in-memory ring buffer — an hour of history in a few KB. That buffer is what makes
// the sparklines, the p50/p95/p99 chips and the per-minute status strip REAL numbers rather than
// decoration. Deliberately in-memory only: history resets with the process, and the API says how
// much has been collected so the UI can say "collecting" instead of faking continuity.
//
// Nothing here ever runs on the request path, and a probe failure is a data point (down), never an
// exception that could take the sampler with it.

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { readFileSync } from 'fs';
import v8 from 'v8';
import { redis }  from '../lib/redis';
import { prisma } from '../lib/prisma';
import {
  resolveMode, describeMode, ephemeralWarning, DB_LABEL, KV_LABEL,
  type NexusMode, type DbEngine, type KvEngine,
} from '../lib/mode';
import {
  RingBuffer, minuteStrip, minuteSeries, percentile, parseRedisInfo, parseCgroupLimit,
  evaluateChecks, summarize, hitRate,
  type HealthSample, type RedisInfoStats, type ReadyCheck, type HealthStatus,
  type StripCell, type MinutePoint,
} from '../lib/health';

export const SAMPLE_INTERVAL_MS = 15_000;
const WINDOW_MINUTES = 60;
const CAPACITY = Math.ceil((WINDOW_MINUTES * 60_000) / SAMPLE_INTERVAL_MS); // 240
const PROBE_TIMEOUT_MS = 3_000;

const samples = new RingBuffer<HealthSample>(CAPACITY);

// Event-loop delay histogram: reset each tick so the percentiles describe the last window, not the
// whole process lifetime (one bad minute at boot would otherwise haunt p99 forever).
let loopHistogram: IntervalHistogram | null = null;

// CPU% needs a delta between two readings; the first tick after start has no baseline and reports 0.
let prevCpu: NodeJS.CpuUsage | null = null;
let prevCpuAt = 0;

let timer: ReturnType<typeof setInterval> | null = null;

// ── Probes ────────────────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('probe timeout')), PROBE_TIMEOUT_MS); });
  try { return await Promise.race([p, timeout]); }
  finally { clearTimeout(t!); }
}

/** Time one Redis PING. A failure (or timeout) is `{ok:false}` — a data point, not an exception. */
export async function probeRedis(): Promise<{ ok: boolean; ms: number | null }> {
  const t0 = performance.now();
  try {
    await withTimeout(redis.ping());
    return { ok: true, ms: performance.now() - t0 };
  } catch { return { ok: false, ms: null }; }
}

/** Time one SELECT 1 on the pool — the same round-trip every real query pays. */
export async function probePostgres(): Promise<{ ok: boolean; ms: number | null }> {
  const t0 = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`);
    return { ok: true, ms: performance.now() - t0 };
  } catch { return { ok: false, ms: null }; }
}

function readLoop(): { p50: number; p99: number } {
  if (!loopHistogram) return { p50: 0, p99: 0 };
  // Histogram values are nanoseconds; the monitor's own sampling resolution (~10ms) is included in
  // the delay it reports, so subtract nothing — operators compare ticks against the same baseline.
  const p50 = loopHistogram.percentile(50) / 1e6;
  const p99 = loopHistogram.percentile(99) / 1e6;
  loopHistogram.reset();
  return { p50, p99 };
}

function readCpuPct(now: number): number {
  const cur = process.cpuUsage();
  if (!prevCpu) { prevCpu = cur; prevCpuAt = now; return 0; }
  const elapsedUs = (now - prevCpuAt) * 1000;
  const usedUs = (cur.user - prevCpu.user) + (cur.system - prevCpu.system);
  prevCpu = cur; prevCpuAt = now;
  return elapsedUs > 0 ? Math.max(0, (usedUs / elapsedUs) * 100) : 0;
}

/** Take one sample. Exported for tests and called on an interval by startHealthSampler. */
export async function takeSample(now: number = Date.now()): Promise<HealthSample> {
  const [r, p] = await Promise.all([probeRedis(), probePostgres()]);
  const loop = readLoop();
  const mem  = process.memoryUsage();
  const s: HealthSample = {
    ts: now,
    redisOk: r.ok, redisMs: r.ms,
    pgOk: p.ok, pgMs: p.ms,
    loopP50Ms: loop.p50, loopP99Ms: loop.p99,
    cpuPct: readCpuPct(now),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
  };
  samples.push(s);
  return s;
}

export function startHealthSampler(): void {
  if (timer) return;
  loopHistogram = monitorEventLoopDelay({ resolution: 20 });
  loopHistogram.enable();
  // First sample immediately, so the page has one real reading instead of an empty hour.
  void takeSample().catch(() => {});
  timer = setInterval(() => { void takeSample().catch(() => {}); }, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref(); // never hold the process open
}

export function stopHealthSampler(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (loopHistogram) { loopHistogram.disable(); loopHistogram = null; }
  samples.clear();
  prevCpu = null;
}

// ── Container / heap limits ───────────────────────────────────────────────────

/** The container's real memory ceiling from the cgroup fs (v2 then v1); null outside a container
 *  or when unlimited. NEVER os.totalmem() — inside Docker that is the HOST's RAM, and a gauge
 *  against it would be a lie. */
export function readContainerMemoryLimit(): number | null {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const limit = parseCgroupLimit(readFileSync(path, 'utf8'));
      if (limit !== null) return limit;
    } catch { /* not present on this platform — fine */ }
  }
  return null;
}

export function heapLimitBytes(): number {
  return v8.getHeapStatistics().heap_size_limit;
}

// ── Readiness (GET /ready) ────────────────────────────────────────────────────
// Live probes, not cached samples: a load balancer asking "can I send traffic?" deserves the truth
// as of NOW, and PING + SELECT 1 are cheap. Loop lag and heap come from the running monitors.

export async function runReadyChecks(): Promise<{ ready: boolean; status: HealthStatus; checks: ReadyCheck[] }> {
  const [r, p] = await Promise.all([probeRedis(), probePostgres()]);
  const last = samples.values().at(-1);
  const checks = evaluateChecks({
    redisOk: r.ok, redisMs: r.ms,
    pgOk: p.ok, pgMs: p.ms,
    loopP99Ms: last?.loopP99Ms ?? 0,
    heapUsedBytes: process.memoryUsage().heapUsed,
    heapLimitBytes: heapLimitBytes(),
  });
  const { status } = summarize(checks);
  // Only a dead dependency refuses traffic. "Degraded" still serves — pulling a slow-but-working
  // gateway out of rotation turns a slowdown into an outage.
  return { ready: !checks.some((c) => c.status === 'down'), status, checks };
}

// ── The dashboard read (GET /admin/health/overview) ──────────────────────────

interface PgStats {
  version:        string | null;
  maxConnections: number | null;
  connections:    { total: number; active: number; idle: number } | null;
  cacheHitRatio:  number | null;
  commits:        number | null;   // cumulative, since pg stats reset
  rollbacks:      number | null;
  deadlocks:      number | null;
  tempBytes:      number | null;
  databaseBytes:  number | null;
  longestTxnSeconds: number | null;
  largestTables:  { name: string; rows: number; bytes: number }[];
}

/** Postgres introspection, each query independently guarded: a managed instance that refuses one
 *  view must not blank the whole panel — absent facts are null, present ones still show. */
async function readPgStats(): Promise<PgStats> {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const [versionRow, settingsRow, connRows, dbRows, sizeRow, txnRow, tableRows] = await Promise.all([
    prisma.$queryRaw<{ v: string }[]>`SELECT version() AS v`.catch(() => []),
    prisma.$queryRaw<{ v: string }[]>`SELECT setting AS v FROM pg_settings WHERE name = 'max_connections'`.catch(() => []),
    prisma.$queryRaw<{ total: number; active: number; idle: number }[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE state = 'active')::int AS active,
             COUNT(*) FILTER (WHERE state = 'idle')::int   AS idle
      FROM pg_stat_activity WHERE datname = current_database()`.catch(() => []),
    prisma.$queryRaw<{ commits: number; rollbacks: number; blksRead: number; blksHit: number; deadlocks: number; tempBytes: number }[]>`
      SELECT xact_commit::float8 AS commits, xact_rollback::float8 AS rollbacks,
             blks_read::float8 AS "blksRead", blks_hit::float8 AS "blksHit",
             deadlocks::float8 AS deadlocks, temp_bytes::float8 AS "tempBytes"
      FROM pg_stat_database WHERE datname = current_database()`.catch(() => []),
    prisma.$queryRaw<{ bytes: number }[]>`SELECT pg_database_size(current_database())::float8 AS bytes`.catch(() => []),
    prisma.$queryRaw<{ secs: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM MAX(now() - xact_start))::float8 AS secs
      FROM pg_stat_activity WHERE state <> 'idle' AND xact_start IS NOT NULL`.catch(() => []),
    prisma.$queryRaw<{ name: string; rows: number; bytes: number }[]>`
      SELECT relname AS name, n_live_tup::float8 AS rows, pg_total_relation_size(relid)::float8 AS bytes
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5`.catch(() => []),
  ]);

  const db = dbRows[0];
  const blksRead = num(db?.blksRead), blksHit = num(db?.blksHit);
  const reads = (blksRead ?? 0) + (blksHit ?? 0);
  // "PostgreSQL 16.2 on x86_64…" → "16.2"
  //
  // Both `?.`s are load-bearing. The first guards a missing row (the query is `.catch(() => [])`, so
  // a failure arrives as an empty array); the second guards a row whose column is null or absent. It
  // was `?.v.match(...)` — row-guarded but column-unguarded — which turns any unexpected shape from
  // `SELECT version()` into a TypeError that takes the whole Health response down, rather than the
  // "version —" the UI already knows how to render.
  const version = versionRow[0]?.v?.match(/PostgreSQL\s+([\d.]+)/)?.[1] ?? null;

  return {
    version,
    maxConnections: settingsRow[0] ? Number(settingsRow[0].v) || null : null,
    connections:    connRows[0] ?? null,
    cacheHitRatio:  blksHit !== null && reads > 0 ? blksHit / reads : null,
    commits:        num(db?.commits),
    rollbacks:      num(db?.rollbacks),
    deadlocks:      num(db?.deadlocks),
    tempBytes:      num(db?.tempBytes),
    databaseBytes:  num(sizeRow[0]?.bytes),
    longestTxnSeconds: num(txnRow[0]?.secs),
    largestTables:  tableRows.map((t) => ({ name: t.name, rows: t.rows, bytes: t.bytes })),
  };
}

async function readRedisStats(): Promise<RedisInfoStats | null> {
  try { return parseRedisInfo(await withTimeout(redis.info())); }
  catch { return null; }
}

/**
 * Which stores this gateway is running on (S0). Reported so an operator never has to infer it from
 * environment variables they may not be able to see — and so a gateway whose counters live in memory
 * says so in the dashboard rather than looking identical to a replicated production one.
 *
 * Admin-only, deliberately: the public /health and /ready stay `{ok, ts}` and a check list. "This
 * gateway keeps its rate-limit windows in memory and runs one process" is a useful thing to know
 * before attacking it, so it is not something an unauthenticated caller gets.
 */
export interface BackendInfo {
  mode: NexusMode;
  db:   DbEngine;
  kv:   KvEngine;
  /** Display names, resolved server-side so the dashboard never hardcodes an engine name. */
  dbLabel: string;
  kvLabel: string;
  /** False when a restart would lose something (in-memory counters). */
  durable: boolean;
  /** One line naming the pair, e.g. "PostgreSQL + Redis". */
  summary: string;
  /** The caution to show alongside it, or null when there is nothing to caution about. */
  warning: string | null;
}

export interface HealthOverview {
  status:  HealthStatus;
  summary: string;
  checks:  ReadyCheck[];
  ready:   boolean;
  backend: BackendInfo;
  strip:   StripCell[];        // last 60 minutes, oldest first
  series:  MinutePoint[];      // per-minute aggregates for the sparklines
  window:  { minutes: number; samples: number; capacity: number };  // how much history exists yet
  sampledAt: string | null;
  redis: {
    up: boolean; pingMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
    info: RedisInfoStats | null; hitRate: number | null;
  };
  postgres: {
    up: boolean; queryMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
    stats: PgStats | null;
  };
  process: {
    node: string; uptimeSeconds: number; pid: number;
    loopP50Ms: number; loopP99Ms: number; loopMaxP99Ms: number | null;
    cpuPct: number; rssBytes: number;
    heapUsedBytes: number; heapLimitBytes: number;
    containerLimitBytes: number | null;   // null = not in a container / no cgroup limit — no gauge, no lie
  };
}

export async function getHealthOverview(now: number = Date.now()): Promise<HealthOverview> {
  const all  = samples.values();
  const last = all.at(-1) ?? null;

  const [redisInfo, pgStats] = await Promise.all([readRedisStats(), readPgStats()]);

  const redisSeries = all.map((s) => s.redisMs).filter((v): v is number => v !== null);
  const pgSeries    = all.map((s) => s.pgMs).filter((v): v is number => v !== null);

  const checks = evaluateChecks({
    redisOk: last?.redisOk ?? false, redisMs: last?.redisMs ?? null,
    pgOk: last?.pgOk ?? false, pgMs: last?.pgMs ?? null,
    loopP99Ms: last?.loopP99Ms ?? 0,
    heapUsedBytes: last?.heapUsedBytes ?? process.memoryUsage().heapUsed,
    heapLimitBytes: heapLimitBytes(),
  });
  const { status, summary } = summarize(checks);

  const m = resolveMode();

  return {
    status, summary, checks,
    ready: !checks.some((c) => c.status === 'down'),
    backend: {
      mode: m.mode, db: m.db, kv: m.kv,
      dbLabel: DB_LABEL[m.db], kvLabel: KV_LABEL[m.kv],
      durable: m.durable,
      summary: describeMode(m),
      warning: ephemeralWarning(m),
    },
    strip:  minuteStrip(all, WINDOW_MINUTES, now),
    series: minuteSeries(all, WINDOW_MINUTES, now),
    window: { minutes: WINDOW_MINUTES, samples: all.length, capacity: CAPACITY },
    sampledAt: last ? new Date(last.ts).toISOString() : null,
    redis: {
      up: last?.redisOk ?? false,
      pingMs: last?.redisMs ?? null,
      p50Ms: percentile(redisSeries, 50), p95Ms: percentile(redisSeries, 95), p99Ms: percentile(redisSeries, 99),
      info: redisInfo,
      hitRate: redisInfo ? hitRate(redisInfo.keyspaceHits, redisInfo.keyspaceMisses) : null,
    },
    postgres: {
      up: last?.pgOk ?? false,
      queryMs: last?.pgMs ?? null,
      p50Ms: percentile(pgSeries, 50), p95Ms: percentile(pgSeries, 95), p99Ms: percentile(pgSeries, 99),
      stats: pgStats,
    },
    process: {
      node: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      loopP50Ms: last?.loopP50Ms ?? 0,
      loopP99Ms: last?.loopP99Ms ?? 0,
      loopMaxP99Ms: all.length ? Math.max(...all.map((s) => s.loopP99Ms)) : null,
      cpuPct: last?.cpuPct ?? 0,
      rssBytes: last?.rssBytes ?? process.memoryUsage().rss,
      heapUsedBytes: last?.heapUsedBytes ?? process.memoryUsage().heapUsed,
      heapLimitBytes: heapLimitBytes(),
      containerLimitBytes: readContainerMemoryLimit(),
    },
  };
}
