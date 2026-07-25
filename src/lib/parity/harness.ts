/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Two real databases, one seed, one set of assertions (Phase S2.1).
//
// The dialect twins in the services cannot be checked by reasoning about SQL — that is exactly the
// activity that produced the seven traps in the first place. So this harness stands up a real
// PostgreSQL and a real SQLite, puts byte-identical rows in both, and runs the twins against them.
//
// It is the database counterpart of the S1 KV parity suite, and it exists for the same reason: the
// translations look obviously correct and four of the seven ways they can be wrong produce no error
// at all.

import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dayKey, toDate, type DualSql } from '../dialect';

const ROOT = resolve(__dirname, '..', '..', '..');

/** A real Postgres to compare against. Absent locally is tolerated; absent in CI is a failure. */
export const PARITY_DATABASE_URL = process.env.PARITY_DATABASE_URL?.trim() || '';

export interface Engines {
  pg: PrismaClient;
  sqlite: PrismaClient;
  dispose: () => Promise<void>;
}

function push(schema: string, url: string): void {
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--schema', join(ROOT, 'prisma', schema), '--skip-generate', '--accept-data-loss', '--force-reset'],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', shell: true, cwd: ROOT },
  );
}

/**
 * Stand up both engines with the schema applied.
 *
 * `--force-reset` on the Postgres side is why PARITY_DATABASE_URL must name a throwaway database
 * and never a real one: it drops everything before recreating it.
 */
export function startEngines(): Engines {
  const dir     = mkdtempSync(join(tmpdir(), 'nexus-parity-'));
  const fileUrl = `file:${join(dir, 'parity.db')}`;

  push('schema.sqlite.prisma', fileUrl);
  push('schema.prisma', PARITY_DATABASE_URL);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SqliteClient = (require('.prisma/client-sqlite') as { PrismaClient: new (o?: unknown) => PrismaClient }).PrismaClient;

  const pg     = new PrismaClient({ datasources: { db: { url: PARITY_DATABASE_URL } }, log: ['error'] });
  const sqlite = new SqliteClient({ datasources: { db: { url: fileUrl } }, log: ['error'] });

  return {
    pg,
    sqlite,
    dispose: async () => {
      await Promise.all([pg.$disconnect(), sqlite.$disconnect()]);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
    },
  };
}

// ── The seed ─────────────────────────────────────────────────────────────────────────────────
// Fixed timestamps, never `Date.now()`: a seed that moves with the clock turns a day-bucketing bug
// into a test that fails only when the suite happens to run near midnight.

export const T0     = new Date('2026-03-01T00:00:00.000Z');   // window start
export const UNTIL  = new Date('2026-03-05T00:00:00.000Z');   // window end
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 2, day, hour, 30, 0));

interface UsageSeed {
  id: string; day: number; hour: number; model: string; provider: string;
  input: number; output: number; usd: number; latency: number;
  outcome?: string; cached?: boolean; saved?: number; unit?: string; quantity?: number;
  teamKey?: string | null;
}

/**
 * Deliberately awkward data. Each row is here to make a specific translation provable:
 * several distinct days including one straddling a UTC boundary, both outcomes, cached rows with
 * savings, `latencyMs = 0` rows that every latency figure must ignore, a non-token modality, and
 * blank model/provider strings that the aggregates are supposed to exclude.
 */
const USAGE: UsageSeed[] = [
  { id: 'u01', day: 1, hour:  9, model: 'gpt-4o',        provider: 'openai',    input: 100, output:  50, usd: 0.50, latency: 120, teamKey: 'tk1' },
  { id: 'u02', day: 1, hour: 23, model: 'gpt-4o',        provider: 'openai',    input: 200, output: 100, usd: 1.00, latency: 340, teamKey: 'tk1' },
  { id: 'u03', day: 2, hour:  0, model: 'claude-opus-5', provider: 'anthropic', input: 300, output: 150, usd: 2.50, latency:  80, teamKey: 'tk2' },
  { id: 'u04', day: 2, hour: 12, model: 'claude-opus-5', provider: 'anthropic', input:  10, output:   5, usd: 0.05, latency: 900, teamKey: 'tk2' },
  // Failures: no tokens, no cost, and they must not count toward success or latency.
  { id: 'u05', day: 2, hour: 13, model: '',              provider: '',          input:   0, output:   0, usd: 0,    latency:   0, outcome: 'upstream_error' },
  { id: 'u06', day: 3, hour:  1, model: '',              provider: 'openai',    input:   0, output:   0, usd: 0,    latency:   0, outcome: 'client_error' },
  // Cache hits: zero cost, a recorded saving.
  { id: 'u07', day: 3, hour:  8, model: 'gpt-4o',        provider: 'openai',    input:  80, output:  40, usd: 0,    latency:   5, cached: true, saved: 0.42, teamKey: 'tk1' },
  { id: 'u08', day: 3, hour:  9, model: 'gpt-4o',        provider: 'openai',    input:  80, output:  40, usd: 0,    latency:   7, cached: true, saved: 0.42, teamKey: 'tk1' },
  // A non-token modality, so the unit split has something to split.
  { id: 'u09', day: 4, hour: 10, model: 'dall-e-3',      provider: 'openai',    input:   0, output:   0, usd: 0.16, latency: 4200, unit: 'image', quantity: 2, teamKey: 'tk2' },
  // A row measured at 0ms — written before latency was recorded. Every latency figure must skip it.
  { id: 'u10', day: 4, hour: 11, model: 'gpt-4o',        provider: 'openai',    input:  60, output:  30, usd: 0.30, latency:   0, teamKey: 'tk1' },
  // Outside the window on both sides, to prove the range bounds are actually applied.
  { id: 'u11', day: 0, hour: 12, model: 'gpt-4o',        provider: 'openai',    input: 999, output: 999, usd: 9.99, latency: 111 },
  { id: 'u12', day: 6, hour: 12, model: 'gpt-4o',        provider: 'openai',    input: 999, output: 999, usd: 9.99, latency: 222 },
];

export const TEAM_A = 'team-aaaa-0000-0000-0000-000000000001';
export const TEAM_B = 'team-bbbb-0000-0000-0000-000000000002';

/** Write the identical seed into both engines through the typed API, which is engine-agnostic. */
export async function seedBoth(e: Engines): Promise<void> {
  for (const db of [e.pg, e.sqlite]) {
    await db.tokenUsage.deleteMany({});
    await db.nexusTeamKey.deleteMany({});
    await db.team.deleteMany({});

    await db.team.createMany({ data: [
      { id: TEAM_A, name: 'Team A', budgetUsd: 100, budgetPeriod: 'monthly' },
      { id: TEAM_B, name: 'Team B' },
    ] });
    await db.nexusTeamKey.createMany({ data: [
      { id: 'tk1', name: 'Key One',  encryptedKey: 'e1', keyHash: 'h1', maskedKey: 'sk-…001', teamId: TEAM_A },
      { id: 'tk2', name: 'Key Two',  encryptedKey: 'e2', keyHash: 'h2', maskedKey: 'sk-…002', teamId: TEAM_A },
      // An idle key: it must still appear in the member breakdown, with zeros, rather than vanish.
      { id: 'tk3', name: 'Key Idle', encryptedKey: 'e3', keyHash: 'h3', maskedKey: 'sk-…003', teamId: TEAM_A },
      { id: 'tk4', name: 'Other',    encryptedKey: 'e4', keyHash: 'h4', maskedKey: 'sk-…004', teamId: TEAM_B },
    ] });

    for (const r of USAGE) {
      await db.tokenUsage.create({ data: {
        id: r.id,
        sessionId: 'sess', modelId: r.model, modelName: r.model, provider: r.provider,
        inputTokens: r.input, outputTokens: r.output, totalTokens: r.input + r.output,
        estimatedUsd: r.usd, latencyMs: r.latency,
        outcome: r.outcome ?? 'success',
        cached: r.cached ?? false, savedUsd: r.saved ?? 0,
        unit: r.unit ?? 'token', quantity: r.quantity ?? 0,
        nexusTeamKeyId: r.teamKey ?? null,
        createdAt: at(r.day, r.hour),
      } });
    }
  }
}

// ── Comparison ───────────────────────────────────────────────────────────────────────────────

/**
 * Which columns go through production's own normalisers before comparison.
 *
 * Two columns are genuinely allowed to arrive in different shapes, because no SQL rewrite can make
 * them agree: a day bucket is a timestamp on Postgres and a `YYYY-MM-DD` string on SQLite, and an
 * aggregated timestamp is a Date on Postgres and epoch millis on SQLite. Production reconciles both
 * with `dayKey()` and `toDate()`, so the comparison applies THE SAME functions rather than a
 * lenient rule of its own — if those helpers are wrong, this suite has to fail, not paper over it.
 *
 * Every other column is compared as it came back. That is the point: a BigInt from a missing cast
 * or a null from a mistranslated date_trunc has to show up as a difference.
 */
export interface Shapes {
  /** Columns holding a day bucket (`date_trunc` / `date(…,'unixepoch')`). */
  day?: string[];
  /** Columns holding a timestamp that came through an aggregate (`MAX("createdAt")`). */
  time?: string[];
}

/**
 * Reduce a row set to something two engines can be compared on.
 *
 * Numbers are rounded to six decimals, because the same float arithmetic in two engines is allowed
 * to differ in the last bits and no dashboard can tell. BigInt is stringified rather than coerced
 * to a number — a missing CAST has to be visible, not quietly repaired by the comparison.
 */
export function normalise(rows: unknown[], shapes: Shapes = {}): unknown[] {
  const days  = new Set(shapes.day ?? []);
  const times = new Set(shapes.time ?? []);

  const one = (k: string, v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (days.has(k))  return dayKey(v as Date | string | number);
    if (times.has(k)) return toDate(v as Date | string | number)?.toISOString() ?? null;
    if (typeof v === 'bigint') return `BIGINT(${v})`;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
    if (v instanceof Date)     return v.toISOString();
    return v;
  };

  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, one(k, o[k])]));
  });
}

/** Run both halves of a twin against their own engine. */
export async function runBoth(e: Engines, q: DualSql): Promise<{ pg: unknown[]; sqlite: unknown[] }> {
  const [pg, sqlite] = await Promise.all([
    e.pg.$queryRaw(q.pg) as Promise<unknown[]>,
    e.sqlite.$queryRaw(q.sqlite) as Promise<unknown[]>,
  ]);
  return { pg, sqlite };
}
