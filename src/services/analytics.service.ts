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

// Analytics aggregate (Phase 7.5): the single read behind the Analytics page — reliability, speed,
// spend, and what the response cache saved, over one window. It reads the per-request rows that
// 7.5a began writing; before that, failures and cache savings simply were not in the data, which is
// why this page could not exist.
//
// Every figure is aggregated in Postgres. A 90-day window in a busy deployment holds far too many
// rows to pull into memory and fold in JavaScript; each query below returns a fixed, tiny result
// regardless of how many rows it scanned.

import { Prisma } from '@prisma/client';
import { dual, dualQuery, dayKey, num, sqliteDay, type DualSql } from '../lib/dialect';
import { dateRange, fillSeries } from '../lib/series';

export type AnalyticsPeriod = 'today' | '7d' | '30d' | '90d';

const TOP_N = 8;

function getSince(period: AnalyticsPeriod): Date {
  if (period === 'today') return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}

export interface AnalyticsTotals {
  requests:      number;  // every attempt, successful or not
  successes:     number;
  errors:        number;
  successRate:   number;  // 0–1; 0 when there is no traffic
  inputTokens:   number;
  outputTokens:  number;
  totalTokens:   number;
  estimatedUsd:  number;
  avgLatencyMs:  number;
  p95LatencyMs:  number;
  cacheHits:     number;
  cacheHitRate:  number;  // 0–1, over successful requests
  cacheSavedUsd: number;
}

export interface AnalyticsDay {
  date: string; requests: number; successes: number; errors: number;
  usd: number; savedUsd: number; cacheHits: number; avgLatencyMs: number;
}

export interface AnalyticsOverview {
  period: AnalyticsPeriod;
  since:  string;
  until:  string;
  totals: AnalyticsTotals;
  byDay:      AnalyticsDay[];
  byModel:    { model: string; requests: number; tokens: number; usd: number }[];
  byProvider: { provider: string; requests: number; errors: number; tokens: number; usd: number }[];
  byModality: { unit: string; requests: number; quantity: number; tokens: number; usd: number }[];
  byOutcome:  { outcome: string; requests: number }[];
}

// Raw row shapes. Sums are cast to float8 and counts to int so the driver yields plain numbers
// rather than BigInt/Decimal, which would not survive JSON serialization cleanly.
type TotalsRow = {
  requests: number; successes: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  estimatedUsd: number | null; savedUsd: number | null;
  cacheHits: number; avgLatencyMs: number | null; p95LatencyMs: number | null;
};
type DayRow = {
  // Postgres `date_trunc` returns a timestamp; SQLite's `date(…, 'unixepoch')` returns a
  // `YYYY-MM-DD` string. `dayKey()` reduces both to the same day, and is the only thing that
  // should ever read this field.
  day: Date | string; requests: number; successes: number;
  usd: number | null; savedUsd: number | null; cacheHits: number; avgLatencyMs: number | null;
};

// ── Queries ──────────────────────────────────────────────────────────────────────────────────
// Declared as engine pairs and exported so the parity suite executes these exact texts against a
// real PostgreSQL and a real SQLite and compares the answers.
//
// The Postgres half is what production has been running since 7.5, with ONE deliberate change: the
// four `ORDER BY requests DESC` clauses gained a tiebreaker on the group key. The parity suite
// found that ties were being broken differently by the two engines, which meant they had never been
// broken deterministically at all — with LIMIT 8 on the model and provider breakdowns, tied rows
// could change which entries appeared in the top eight from one query to the next. Postgres has
// never promised an order it was not asked for; it simply happened to be stable in practice. The
// tiebreaker is two words per query and makes the result reproducible on both engines.

export const ANALYTICS_TOTALS = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT COUNT(*)::int                                             AS requests,
             COUNT(*) FILTER (WHERE "outcome" = 'success')::int        AS successes,
             SUM("inputTokens")::float8                                AS "inputTokens",
             SUM("outputTokens")::float8                               AS "outputTokens",
             SUM("totalTokens")::float8                                AS "totalTokens",
             SUM("estimatedUsd")::float8                               AS "estimatedUsd",
             SUM("savedUsd")::float8                                   AS "savedUsd",
             COUNT(*) FILTER (WHERE "cached")::int                     AS "cacheHits",
             AVG("latencyMs") FILTER (WHERE "latencyMs" > 0)::float8   AS "avgLatencyMs",
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")
               FILTER (WHERE "latencyMs" > 0))::float8                 AS "p95LatencyMs"
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}`,

  // SQLite has no percentile_cont, so p95 is a correlated nearest-rank pick instead: order the
  // measured latencies and take the sample at the 95th position. This is a REAL difference, not an
  // implementation detail — Postgres interpolates between the two samples straddling the boundary,
  // this returns the nearer observed one. Over a realistic window they agree to a millisecond or
  // two; over a handful of requests they can differ visibly. The alternative was pulling every
  // latency into memory to interpolate in JS, which buys precision nobody can act on at a cost that
  // grows with the table. The parity suite bounds the disagreement rather than ignoring it.
  Prisma.sql`
      SELECT CAST(COUNT(*) AS REAL)                                            AS requests,
             CAST(COUNT(*) FILTER (WHERE "outcome" = 'success') AS REAL)       AS successes,
             CAST(SUM("inputTokens") AS REAL)                                  AS "inputTokens",
             CAST(SUM("outputTokens") AS REAL)                                 AS "outputTokens",
             CAST(SUM("totalTokens") AS REAL)                                  AS "totalTokens",
             CAST(SUM("estimatedUsd") AS REAL)                                 AS "estimatedUsd",
             CAST(SUM("savedUsd") AS REAL)                                     AS "savedUsd",
             CAST(COUNT(*) FILTER (WHERE "cached") AS REAL)                    AS "cacheHits",
             CAST(AVG("latencyMs") FILTER (WHERE "latencyMs" > 0) AS REAL)     AS "avgLatencyMs",
             (SELECT CAST(p."latencyMs" AS REAL) FROM "TokenUsage" p
               WHERE p."latencyMs" > 0 AND p."createdAt" >= ${since} AND p."createdAt" <= ${until}
               ORDER BY p."latencyMs"
               LIMIT 1 OFFSET MAX(0, CAST((SELECT COUNT(*) FROM "TokenUsage" q
                 WHERE q."latencyMs" > 0 AND q."createdAt" >= ${since} AND q."createdAt" <= ${until}
               ) * 0.95 AS INTEGER) - 1))                                      AS "p95LatencyMs"
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}`,
);

export const ANALYTICS_BY_DAY = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT date_trunc('day', "createdAt")                            AS day,
             COUNT(*)::int                                             AS requests,
             COUNT(*) FILTER (WHERE "outcome" = 'success')::int        AS successes,
             SUM("estimatedUsd")::float8                               AS usd,
             SUM("savedUsd")::float8                                   AS "savedUsd",
             COUNT(*) FILTER (WHERE "cached")::int                     AS "cacheHits",
             AVG("latencyMs") FILTER (WHERE "latencyMs" > 0)::float8   AS "avgLatencyMs"
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,

  Prisma.sql`
      SELECT ${Prisma.raw(sqliteDay('"createdAt"'))}                        AS day,
             CAST(COUNT(*) AS REAL)                                         AS requests,
             CAST(COUNT(*) FILTER (WHERE "outcome" = 'success') AS REAL)    AS successes,
             CAST(SUM("estimatedUsd") AS REAL)                              AS usd,
             CAST(SUM("savedUsd") AS REAL)                                  AS "savedUsd",
             CAST(COUNT(*) FILTER (WHERE "cached") AS REAL)                 AS "cacheHits",
             CAST(AVG("latencyMs") FILTER (WHERE "latencyMs" > 0) AS REAL)  AS "avgLatencyMs"
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY day ORDER BY day ASC`,
);

// A failed request records no model, so the empty string is excluded rather than shown as a
// nameless row.
export const ANALYTICS_BY_MODEL = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT "modelName"                AS model,
             COUNT(*)::int              AS requests,
             SUM("totalTokens")::float8 AS tokens,
             SUM("estimatedUsd")::float8 AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "modelName" <> ''
      GROUP BY "modelName" ORDER BY requests DESC, "modelName" ASC LIMIT ${TOP_N}`,

  Prisma.sql`
      SELECT "modelName"                      AS model,
             CAST(COUNT(*) AS REAL)           AS requests,
             CAST(SUM("totalTokens") AS REAL) AS tokens,
             CAST(SUM("estimatedUsd") AS REAL) AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "modelName" <> ''
      GROUP BY "modelName" ORDER BY requests DESC, "modelName" ASC LIMIT ${TOP_N}`,
);

export const ANALYTICS_BY_PROVIDER = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT "provider"                                          AS provider,
             COUNT(*)::int                                       AS requests,
             COUNT(*) FILTER (WHERE "outcome" <> 'success')::int AS errors,
             SUM("totalTokens")::float8                          AS tokens,
             SUM("estimatedUsd")::float8                         AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "provider" <> ''
      GROUP BY "provider" ORDER BY requests DESC, "provider" ASC LIMIT ${TOP_N}`,

  Prisma.sql`
      SELECT "provider"                                                 AS provider,
             CAST(COUNT(*) AS REAL)                                     AS requests,
             CAST(COUNT(*) FILTER (WHERE "outcome" <> 'success') AS REAL) AS errors,
             CAST(SUM("totalTokens") AS REAL)                           AS tokens,
             CAST(SUM("estimatedUsd") AS REAL)                          AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "provider" <> ''
      GROUP BY "provider" ORDER BY requests DESC, "provider" ASC LIMIT ${TOP_N}`,
);

// Modality mix (token / image / character / transcription). Only successful requests bought
// anything, so a failure would otherwise inflate the "token" bucket with rows that did nothing.
export const ANALYTICS_BY_MODALITY = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT "unit"                     AS unit,
             COUNT(*)::int              AS requests,
             SUM("quantity")::float8    AS quantity,
             SUM("totalTokens")::float8 AS tokens,
             SUM("estimatedUsd")::float8 AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "outcome" = 'success'
      GROUP BY "unit" ORDER BY requests DESC, "unit" ASC`,

  Prisma.sql`
      SELECT "unit"                           AS unit,
             CAST(COUNT(*) AS REAL)           AS requests,
             CAST(SUM("quantity") AS REAL)    AS quantity,
             CAST(SUM("totalTokens") AS REAL) AS tokens,
             CAST(SUM("estimatedUsd") AS REAL) AS usd
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until} AND "outcome" = 'success'
      GROUP BY "unit" ORDER BY requests DESC, "unit" ASC`,
);

export const ANALYTICS_BY_OUTCOME = (since: Date, until: Date): DualSql => dual(
  Prisma.sql`
      SELECT "outcome" AS outcome, COUNT(*)::int AS requests
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY "outcome" ORDER BY requests DESC, "outcome" ASC`,

  Prisma.sql`
      SELECT "outcome" AS outcome, CAST(COUNT(*) AS REAL) AS requests
      FROM "TokenUsage"
      WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY "outcome" ORDER BY requests DESC, "outcome" ASC`,
);

/**
 * One aggregate for the Analytics page.
 *
 * Latency deliberately ignores rows whose `latencyMs` is 0: those are the rows written before 7.5a,
 * which never measured it. Averaging them in would drag every latency figure toward zero and quietly
 * flatter the gateway — a "0ms" reading is a missing measurement, not a fast request.
 */
export async function getAnalyticsOverview(
  period: AnalyticsPeriod = '7d',
  customSince?: Date,
  customUntil?: Date,
): Promise<AnalyticsOverview> {
  const since = customSince ?? getSince(period);
  const until = customUntil ?? new Date();

  const [totalsRows, dayRows, modelRows, providerRows, modalityRows, outcomeRows] = await Promise.all([
    dualQuery<TotalsRow>(ANALYTICS_TOTALS(since, until)),
    dualQuery<DayRow>(ANALYTICS_BY_DAY(since, until)),
    dualQuery<{ model: string; requests: number; tokens: number | null; usd: number | null }>(
      ANALYTICS_BY_MODEL(since, until)),
    dualQuery<{ provider: string; requests: number; errors: number; tokens: number | null; usd: number | null }>(
      ANALYTICS_BY_PROVIDER(since, until)),
    dualQuery<{ unit: string; requests: number; quantity: number | null; tokens: number | null; usd: number | null }>(
      ANALYTICS_BY_MODALITY(since, until)),
    dualQuery<{ outcome: string; requests: number }>(ANALYTICS_BY_OUTCOME(since, until)),
  ]);

  const t         = totalsRows[0] ?? ({} as TotalsRow);
  const requests  = num(t.requests);
  const successes = num(t.successes);
  const cacheHits = num(t.cacheHits);

  const totals: AnalyticsTotals = {
    requests,
    successes,
    errors:        requests - successes,
    // A window with no traffic has no success rate to report. Reporting 100% would be a lie of
    // omission — it would paint an idle gateway as a perfectly healthy one.
    successRate:   requests  > 0 ? successes / requests  : 0,
    inputTokens:   num(t.inputTokens),
    outputTokens:  num(t.outputTokens),
    totalTokens:   num(t.totalTokens),
    estimatedUsd:  num(t.estimatedUsd),
    avgLatencyMs:  Math.round(num(t.avgLatencyMs)),
    p95LatencyMs:  Math.round(num(t.p95LatencyMs)),
    cacheHits,
    cacheHitRate:  successes > 0 ? cacheHits / successes : 0,
    cacheSavedUsd: num(t.savedUsd),
  };

  const byDay = fillSeries(
    dayRows.map((r) => {
      const reqs = num(r.requests), ok = num(r.successes);
      return {
        date:         dayKey(r.day),
        requests:     reqs,
        successes:    ok,
        errors:       reqs - ok,
        usd:          num(r.usd),
        savedUsd:     num(r.savedUsd),
        cacheHits:    num(r.cacheHits),
        avgLatencyMs: Math.round(num(r.avgLatencyMs)),
      };
    }),
    dateRange(since, until),
    (date) => ({ date, requests: 0, successes: 0, errors: 0, usd: 0, savedUsd: 0, cacheHits: 0, avgLatencyMs: 0 }),
  );

  return {
    period, since: since.toISOString(), until: until.toISOString(), totals, byDay,
    byModel:    modelRows.map((r)    => ({ model: r.model, requests: num(r.requests), tokens: num(r.tokens), usd: num(r.usd) })),
    byProvider: providerRows.map((r) => ({ provider: r.provider, requests: num(r.requests), errors: num(r.errors), tokens: num(r.tokens), usd: num(r.usd) })),
    byModality: modalityRows.map((r) => ({ unit: r.unit, requests: num(r.requests), quantity: num(r.quantity), tokens: num(r.tokens), usd: num(r.usd) })),
    byOutcome:  outcomeRows.map((r)  => ({ outcome: r.outcome, requests: num(r.requests) })),
  };
}
