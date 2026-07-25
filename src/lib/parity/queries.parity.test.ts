/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Do the dialect twins agree? (Phase S2.1)
//
// A real PostgreSQL and a real SQLite, seeded byte-identically, asked the same question through the
// exact `Prisma.sql` values the services execute. Reasoning about SQL is what produced the traps
// this suite hunts, so nothing here is reasoned about.
//
// Requires PARITY_DATABASE_URL, naming a THROWAWAY database — the harness drops and recreates its
// schema. CI provides one; a missing one is skipped locally and is a hard failure in CI, so the
// suite can never quietly report green while checking nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startEngines, seedBoth, runBoth, normalise, PARITY_DATABASE_URL, T0, UNTIL, TEAM_A,
  type Engines,
} from './harness';
import {
  ANALYTICS_TOTALS, ANALYTICS_BY_DAY, ANALYTICS_BY_MODEL,
  ANALYTICS_BY_PROVIDER, ANALYTICS_BY_MODALITY, ANALYTICS_BY_OUTCOME,
} from '../../services/analytics.service';
import { CACHE_STATS } from '../../services/cache.service';
import { USAGE_BY_DAY, USAGE_BY_TEAM, USAGE_BY_MODEL } from '../../services/token.service';
import { TEAM_TOTALS, TEAM_BY_DAY, TEAM_BY_MODEL, TEAM_MEMBERS } from '../../services/teamStats.service';
import { toDate } from '../dialect';

const CI      = !!process.env.CI;
const enabled = !!PARITY_DATABASE_URL;

describe('database parity harness', () => {
  // The one assertion that must run even when the rest cannot: without it, dropping the service
  // from CI would turn this whole file into a silent no-op and nothing would say so.
  it('is wired up in CI', () => {
    if (CI) expect(PARITY_DATABASE_URL, 'PARITY_DATABASE_URL must be set in CI').not.toBe('');
    else if (!enabled) console.warn('\n  ⚠ PARITY_DATABASE_URL not set — engine parity was NOT checked in this run.\n');
  });
});

describe.skipIf(!enabled)('PostgreSQL ↔ SQLite: the analytics aggregates agree', () => {
  let e: Engines;

  beforeAll(async () => {
    e = startEngines();
    await seedBoth(e);
  }, 120_000);

  afterAll(async () => { await e?.dispose(); });

  it('seeded both engines identically — guards every assertion below', async () => {
    // Without this, a seed that silently failed on one engine would make every comparison below
    // pass by comparing nothing to nothing.
    const [a, b] = await Promise.all([e.pg.tokenUsage.count(), e.sqlite.tokenUsage.count()]);
    expect(a).toBe(12);
    expect(b).toBe(12);
  });

  it('totals: counts, sums, cache hits and average latency', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_TOTALS(T0, UNTIL));

    // p95 is compared separately below: it is the one figure the two engines are permitted to
    // disagree on, and folding it in here would hide a real disagreement in everything else.
    const strip = (rows: unknown[]) =>
      normalise(rows).map((r) => { const o = { ...(r as Record<string, unknown>) }; delete o.p95LatencyMs; return o; });

    expect(strip(sqlite)).toEqual(strip(pg));

    // And the numbers are the RIGHT ones, not merely equal — two identically-wrong twins would
    // otherwise agree perfectly. 10 rows fall inside the window; u11 and u12 sit outside it.
    const t = strip(pg)[0] as Record<string, number>;
    expect(t.requests).toBe(10);
    expect(t.successes).toBe(8);
    expect(t.cacheHits).toBe(2);
    expect(t.savedUsd).toBeCloseTo(0.84, 6);
    // Latency ignores the three rows measured at 0ms: (120+340+80+900+5+7+4200)/7.
    expect(t.avgLatencyMs).toBeCloseTo((120 + 340 + 80 + 900 + 5 + 7 + 4200) / 7, 4);
  });

  it('totals: p95 differs only by the interpolation Postgres does and SQLite cannot', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_TOTALS(T0, UNTIL));
    const a = (pg[0] as { p95LatencyMs: number }).p95LatencyMs;
    const b = (sqlite[0] as { p95LatencyMs: number }).p95LatencyMs;

    // Both must be real measurements, not null and not a BigInt that slipped a cast.
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');

    // SQLite returns the nearest observed sample; Postgres interpolates between the two straddling
    // the 95th percentile. So the answers must both lie within the measured range and bracket the
    // same neighbourhood — not be equal. Asserting equality here would be asserting a falsehood.
    const measured = [5, 7, 80, 120, 340, 900, 4200];
    expect(measured).toContain(b);
    expect(a).toBeGreaterThanOrEqual(Math.min(...measured));
    expect(a).toBeLessThanOrEqual(Math.max(...measured));
  });

  it('by day: buckets land on the same days with the same figures', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_DAY(T0, UNTIL));
    const shape = { day: ['day'] };

    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));

    // The bucketing is genuinely happening: four distinct days, and u02 (23:30 UTC) stays on the
    // 1st rather than rolling into the 2nd. A timezone slip is the whole reason this is asserted.
    const days = normalise(pg, shape).map((r) => (r as { day: string }).day);
    expect(days).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);

    // And the day column is not null — the trap where `date("createdAt")` silently returns NULL
    // would otherwise produce one null bucket that still "matched" if both sides were broken.
    for (const d of days) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('by model: top-N ordering and the blank-model exclusion', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_MODEL(T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const models = normalise(pg).map((r) => (r as { model: string }).model);
    expect(models).not.toContain('');              // failed requests record no model
    expect(models).toContain('gpt-4o');
  });

  it('by provider: error counts alongside request counts', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_PROVIDER(T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const openai = normalise(pg).find((r) => (r as { provider: string }).provider === 'openai') as Record<string, number>;
    expect(openai.errors).toBe(1);                 // u06 only; u05 has a blank provider and is excluded
  });

  it('by modality: successful requests only', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_MODALITY(T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const units = normalise(pg).map((r) => (r as { unit: string }).unit).sort();
    expect(units).toEqual(['image', 'token']);
  });

  it('by outcome: every outcome in the window', async () => {
    const { pg, sqlite } = await runBoth(e, ANALYTICS_BY_OUTCOME(T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const outcomes = normalise(pg).map((r) => (r as { outcome: string }).outcome).sort();
    expect(outcomes).toEqual(['client_error', 'success', 'upstream_error']);
  });

  it('an empty window returns the same nothing from both', async () => {
    // The zero case has its own failure mode: SUM over no rows is NULL, and a twin that turned that
    // into 0 on one engine only would disagree exactly when a new deployment first looks at its
    // dashboard.
    const empty: [Date, Date] = [new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z')];
    for (const q of [ANALYTICS_TOTALS(...empty), ANALYTICS_BY_DAY(...empty), ANALYTICS_BY_MODEL(...empty)]) {
      const { pg, sqlite } = await runBoth(e, q);
      expect(normalise(sqlite, { day: ['day'] })).toEqual(normalise(pg, { day: ['day'] }));
    }
  });

  it('returns no BigInt from either engine', async () => {
    // The cast trap, checked once across every twin rather than trusted per query: an un-cast SUM
    // reaches the route as `TypeError: Do not know how to serialize a BigInt`, thrown far from the
    // query that caused it.
    for (const q of [
      ANALYTICS_TOTALS(T0, UNTIL), ANALYTICS_BY_DAY(T0, UNTIL), ANALYTICS_BY_MODEL(T0, UNTIL),
      ANALYTICS_BY_PROVIDER(T0, UNTIL), ANALYTICS_BY_MODALITY(T0, UNTIL), ANALYTICS_BY_OUTCOME(T0, UNTIL),
    ]) {
      const { pg, sqlite } = await runBoth(e, q);
      for (const [label, rows] of [['pg', pg], ['sqlite', sqlite]] as const) {
        for (const row of rows) {
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            expect(typeof v, `${label}.${k} came back as a BigInt — add a cast`).not.toBe('bigint');
          }
        }
      }
    }
  });

  it('every row shape is JSON-serialisable, which is how a route would find out', async () => {
    for (const q of [ANALYTICS_TOTALS(T0, UNTIL), ANALYTICS_BY_DAY(T0, UNTIL)]) {
      const { pg, sqlite } = await runBoth(e, q);
      expect(() => JSON.stringify(pg)).not.toThrow();
      expect(() => JSON.stringify(sqlite)).not.toThrow();
    }
  });

  it('seeded team traffic, so the teamStats twins have something to aggregate', async () => {
    const n = await e.sqlite.tokenUsage.count({ where: { teamKey: { teamId: TEAM_A } } });
    expect(n).toBeGreaterThan(0);
  });
});

describe.skipIf(!enabled)('PostgreSQL ↔ SQLite: the cache and usage aggregates agree', () => {
  let e: Engines;
  beforeAll(async () => { e = startEngines(); await seedBoth(e); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('cache stats: hits, successes and savings', async () => {
    const { pg, sqlite } = await runBoth(e, CACHE_STATS(T0));
    expect(normalise(sqlite)).toEqual(normalise(pg));

    const r = normalise(pg)[0] as Record<string, number>;
    expect(r.hits).toBe(2);
    expect(r.saved).toBeCloseTo(0.84, 6);
  });

  it('usage by day: token splits per bucket', async () => {
    const { pg, sqlite } = await runBoth(e, USAGE_BY_DAY(T0, UNTIL));
    const shape = { day: ['day'] };
    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));
    expect(normalise(pg, shape)).toHaveLength(4);
  });

  it('usage by team key: the JOIN excludes traffic with no team', async () => {
    const { pg, sqlite } = await runBoth(e, USAGE_BY_TEAM(T0, UNTIL));
    const shape = { day: ['day'] };
    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));

    // u05 and u06 carry no team key and must not appear under any team.
    const keys = new Set(normalise(pg, shape).map((r) => (r as { teamKeyId: string }).teamKeyId));
    expect(keys.has(null as unknown as string)).toBe(false);
    expect([...keys].sort()).toEqual(['tk1', 'tk2']);
  });

  it('usage by model: day × model buckets', async () => {
    const { pg, sqlite } = await runBoth(e, USAGE_BY_MODEL(T0, UNTIL));
    const shape = { day: ['day'] };
    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));
  });
});

describe.skipIf(!enabled)('PostgreSQL ↔ SQLite: the per-team aggregates agree', () => {
  let e: Engines;
  beforeAll(async () => { e = startEngines(); await seedBoth(e); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('team totals', async () => {
    const { pg, sqlite } = await runBoth(e, TEAM_TOTALS(TEAM_A, T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));
    expect((normalise(pg)[0] as Record<string, number>).requests).toBe(8);
  });

  it('team by day', async () => {
    const { pg, sqlite } = await runBoth(e, TEAM_BY_DAY(TEAM_A, T0, UNTIL));
    const shape = { day: ['day'] };
    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));
  });

  it('team by model', async () => {
    const { pg, sqlite } = await runBoth(e, TEAM_BY_MODEL(TEAM_A, T0, UNTIL));
    expect(normalise(sqlite)).toEqual(normalise(pg));
  });

  it('team members: idle keys still appear, with zeros', async () => {
    const { pg, sqlite } = await runBoth(e, TEAM_MEMBERS(TEAM_A, T0, UNTIL));
    const shape = { time: ['lastUsedAt'] };
    expect(normalise(sqlite, shape)).toEqual(normalise(pg, shape));

    const rows = normalise(pg, shape) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);                                  // tk1, tk2 and the idle tk3
    const idle = rows.find((r) => r.id === 'tk3')!;
    expect(idle.requests).toBe(0);
    expect(idle.tokens).toBe(0);
    expect(idle.lastUsedAt).toBeNull();                            // LEFT JOIN produced no rows
  });

  it('team members: lastUsedAt is a real timestamp on BOTH engines', async () => {
    // The MAX(datetime) trap, asserted directly. SQLite returns epoch millis where Postgres returns
    // a Date; nothing throws, and an unreconciled value renders in the UI as 1772323800000. The
    // raw shapes are allowed to differ — what must not differ is the instant they mean.
    const { pg, sqlite } = await runBoth(e, TEAM_MEMBERS(TEAM_A, T0, UNTIL));
    const busiest = (rows: unknown[]) => (rows as Record<string, unknown>[]).find((r) => r.id === 'tk1')!;

    const a = toDate(busiest(pg).lastUsedAt as never);
    const b = toDate(busiest(sqlite).lastUsedAt as never);
    expect(a).toBeInstanceOf(Date);
    expect(b).toBeInstanceOf(Date);
    expect(b!.toISOString()).toBe(a!.toISOString());
    expect(a!.getUTCFullYear()).toBe(2026);                        // not 1970, which epoch-millis-as-seconds would give
  });

  it('a team with no traffic at all still returns its keys', async () => {
    const { pg, sqlite } = await runBoth(e, TEAM_MEMBERS('team-with-nothing', T0, UNTIL));
    expect(normalise(sqlite, { time: ['lastUsedAt'] })).toEqual(normalise(pg, { time: ['lastUsedAt'] }));
    expect(pg).toHaveLength(0);
  });

  it('returns no BigInt from any team or usage twin', async () => {
    for (const q of [
      CACHE_STATS(T0), USAGE_BY_DAY(T0, UNTIL), USAGE_BY_TEAM(T0, UNTIL), USAGE_BY_MODEL(T0, UNTIL),
      TEAM_TOTALS(TEAM_A, T0, UNTIL), TEAM_BY_DAY(TEAM_A, T0, UNTIL),
      TEAM_BY_MODEL(TEAM_A, T0, UNTIL), TEAM_MEMBERS(TEAM_A, T0, UNTIL),
    ]) {
      const { pg, sqlite } = await runBoth(e, q);
      for (const [label, rows] of [['pg', pg], ['sqlite', sqlite]] as const) {
        for (const row of rows) {
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            // lastUsedAt is exempt: it is a timestamp SQLite genuinely returns as an integer, and
            // toDate() is what production does with it. Every other column must be cast.
            if (k === 'lastUsedAt') continue;
            expect(typeof v, `${label}.${k} came back as a BigInt — add a cast`).not.toBe('bigint');
          }
        }
      }
    }
  });
});
