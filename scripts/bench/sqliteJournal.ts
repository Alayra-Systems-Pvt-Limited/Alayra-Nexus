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

// Why standalone mode runs SQLite in WAL (Phase S2.5).
//
//   npm run bench:sqlite-journal
//
// DELIBERATELY NOT A TEST, and it must never become one. The numbers below are the justification for
// a decision, and a timing assertion on a shared CI runner is the textbook flaky gate — it would go
// red for reasons unrelated to the change in front of it and teach people to rerun until green. What
// belongs in the suite is the deterministic part (that the mode is set, persists, and is reported
// honestly), and that is in src/lib/sqlitePragma.test.ts.
//
// This exists so the decision can be RE-VERIFIED rather than trusted. Run it on the hardware in
// question and see for yourself.
//
// The workload is the gateway's real one: several dashboard aggregates — the shape of
// ANALYTICS_BY_MODEL, a group-and-sum over the whole of TokenUsage — running while the usage
// pipeline and audit buffer flush rows underneath them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

const ROWS = 120_000;
const READERS = 6;
const READS_EACH = 8;
const WRITES = 60;
const RUNS = 3;

interface Result { mode: string; total: number; slowestRead: number; slowestWrite: number; failed: number }

function openAt(file: string): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('.prisma/client-sqlite') as { PrismaClient: new (o?: unknown) => PrismaClient };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3') as {
    PrismaBetterSqlite3: new (opts: { url: string }) => unknown;
  };
  return new mod.PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }), log: [] });
}

async function bench(want: 'delete' | 'wal'): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), `nexus-bench-${want}-`));
  const db = openAt(join(dir, 'bench.db'));

  await db.$executeRawUnsafe('CREATE TABLE u (id INTEGER PRIMARY KEY, model TEXT, cost REAL, ok INT)');
  const mode = (await db.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode = ${want}`))[0].journal_mode;

  // Seeded in one statement so setup never lands inside the measured window.
  await db.$executeRawUnsafe(
    `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < ${ROWS})
     INSERT INTO u (model, cost, ok) SELECT 'm' || (i % 7), i * 0.001, i % 2 FROM s`);

  const read = () => db.$queryRawUnsafe(
    `SELECT model, COUNT(*) AS n, SUM(cost) AS c FROM u WHERE ok = 1 GROUP BY model ORDER BY c DESC`);
  const write = (i: number) => db.$executeRawUnsafe(`INSERT INTO u (model, cost, ok) VALUES ('bg', ${i}, 1)`);

  let slowestRead = 0, slowestWrite = 0, failed = 0;
  const t0 = Date.now();

  await Promise.all([
    ...Array.from({ length: READERS }, async () => {
      for (let i = 0; i < READS_EACH; i++) {
        const t = Date.now();
        await read().catch(() => { failed++; });
        slowestRead = Math.max(slowestRead, Date.now() - t);
      }
    }),
    ...Array.from({ length: WRITES }, async (_, i) => {
      const t = Date.now();
      await write(i).catch(() => { failed++; });
      slowestWrite = Math.max(slowestWrite, Date.now() - t);
    }),
  ]);

  const total = Date.now() - t0;
  await db.$disconnect();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may still hold the file */ }
  return { mode, total, slowestRead, slowestWrite, failed };
}

async function main(): Promise<void> {
  console.log(
    `\n${READERS} concurrent dashboard aggregates over ${ROWS.toLocaleString()} rows, ` +
    `with ${WRITES} background writes landing during them. ${RUNS} runs of each mode.\n`);
  console.log('  mode       total   slowest read   slowest write   failed');
  console.log('  ─────────────────────────────────────────────────────────');

  for (const want of ['delete', 'wal'] as const) {
    for (let i = 0; i < RUNS; i++) {
      const r = await bench(want);
      console.log(
        `  ${r.mode.padEnd(8)} ${String(r.total).padStart(5)}ms ` +
        `${String(r.slowestRead).padStart(11)}ms ${String(r.slowestWrite).padStart(13)}ms ` +
        `${String(r.failed).padStart(8)}`);
    }
  }

  console.log(
    '\n  Read "failed: 0" carefully — at this load `delete` does not lose writes, it delays them ' +
    'behind\n  readers. Losses begin past the 5s busy_timeout, and the slow writes above are the ' +
    'only warning.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
