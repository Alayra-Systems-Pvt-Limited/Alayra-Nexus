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

// Two SQL dialects, one row shape (Phase S2.1).
//
// The typed Prisma API is engine-agnostic, but the dashboard's aggregates are not expressible
// through it — day buckets, conditional counts and percentiles all have to be pushed down as raw
// SQL, and that SQL is where PostgreSQL and SQLite stop agreeing.
//
// The shape here mirrors what worked for the S1 Lua scripts: a query is a PAIR of texts declared
// together, exported as a value, so the parity suite can execute the exact same strings this
// module executes rather than an approximation of them. Writing the two variants adjacent is also
// the only way a reader can see, in one glance, what actually differs between them.
//
// THE POSTGRES TEXT IS NEVER TO BE "IMPROVED" WHILE PASSING THROUGH. It is what production has
// been running; every edit to it is a live regression risk with no corresponding benefit, because
// it already works. The SQLite variant is the new code, and it is the one the parity suite is
// really testing.
//
// ── The seven differences these twins exist to absorb ────────────────────────────────────────
// Established empirically in the S2 audit against a real generated SQLite client, not from docs:
//
//   1. date_trunc('day', x)   — no equivalent. And the obvious `date("createdAt")` returns NULL
//                               rather than erroring, because Prisma stores DateTime as an INTEGER
//                               of epoch milliseconds. Needs date("createdAt"/1000, 'unixepoch').
//   2. COUNT(*) / SUM(int)    — come back as BigInt without a cast, which JSON.stringify throws on.
//                               `::int` / `::float8` become CAST(… AS REAL).
//   3. MAX(datetimeColumn)    — returns epoch millis, not a Date. Silent: the UI renders a number.
//   4. percentile_cont        — does not exist. See `p95` below.
//   5. FILTER (WHERE …)       — SUPPORTED (SQLite ≥ 3.30), so those port unchanged.
//   6. Date parameters        — bind correctly on both. `WHERE "createdAt" >= ${d}` needs no change.
//   7. Identifier quoting     — "Double quotes" work on both.

import { Prisma } from '@prisma/client';
import { prisma, dbEngine } from './prisma';

/** A query written once per engine. Both halves must return the same columns. */
export interface DualSql {
  pg: Prisma.Sql;
  sqlite: Prisma.Sql;
}

/** Declare a query in both dialects. Exported as a value so the parity suite runs this exact text. */
export const dual = (pg: Prisma.Sql, sqlite: Prisma.Sql): DualSql => ({ pg, sqlite });

/** Run whichever half matches the client that was actually constructed. */
export function dualQuery<T>(q: DualSql): Promise<T[]> {
  return prisma.$queryRaw<T[]>(dbEngine === 'sqlite' ? q.sqlite : q.pg) as unknown as Promise<T[]>;
}

// ── Row normalisation ────────────────────────────────────────────────────────────────────────
// Applied on BOTH paths rather than only the SQLite one. A helper used on one engine is a helper
// nobody exercises in CI until standalone mode is running in anger; used on both, every existing
// Postgres test covers it too. Each is a no-op for the engine that already returns the right thing.

/**
 * A day bucket as `YYYY-MM-DD`, from whatever the engine returned.
 *
 * Postgres `date_trunc` yields a Date; SQLite's `date(…, 'unixepoch')` yields a `YYYY-MM-DD`
 * string. Both are UTC — `unixepoch` is UTC by definition and Postgres truncates in the session
 * timezone, which is UTC on every deployment of this gateway — so the two agree on which day a
 * timestamp belongs to. The parity suite asserts that rather than trusting it.
 */
export function dayKey(v: Date | string | number): string {
  if (typeof v === 'string') {
    // Already `YYYY-MM-DD…`; slicing avoids re-parsing (and avoids `new Date('2026-07-20')`
    // being read as UTC midnight on some engines and local midnight on others).
    return v.slice(0, 10);
  }
  return new Date(v).toISOString().slice(0, 10);
}

/**
 * A timestamp column that came back through an aggregate, as a Date or null.
 *
 * `MAX("createdAt")` is the case that matters: Postgres returns a Date, SQLite returns the raw
 * INTEGER of epoch millis. Nothing throws — the UI just renders 1784647800000 as a "last used"
 * time, which is why this is applied rather than left to the caller to remember.
 */
export function toDate(v: Date | string | number | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(typeof v === 'string' ? v : Number(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A numeric aggregate as a plain number.
 *
 * Guards the BigInt case that a missing CAST would produce: without this a single un-cast SUM
 * anywhere in a SQLite twin surfaces as a `TypeError: Do not know how to serialize a BigInt` from
 * the JSON serialiser, thrown from the route rather than from the query that caused it.
 */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

// ── SQLite expression fragments ──────────────────────────────────────────────────────────────
// Named rather than inlined so the same translation is used everywhere and can be corrected in one
// place. Interpolated into raw text, never near user input — these are constants.

/**
 * SQLite's `date_trunc('day', col)`: epoch-millis INTEGER → `YYYY-MM-DD`, UTC.
 *
 * `col` is always a literal column name written by us. It is interpolated into raw SQL, so it must
 * never be given anything that came from a request.
 */
export const sqliteDay = (col: string): string => `date(${col}/1000, 'unixepoch')`;
