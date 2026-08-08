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

// How many database queries does ONE chat completion cost?
//
// The CPU profile (scripts/bench/profile.ts) found that the database layer — Prisma's query
// interpreter, its WASM query compiler, and better-sqlite3 underneath them — is the majority of the
// CPU the gateway spends per request, while our own application code is a few percent. That makes
// the profile's ranking useless on its own: "Prisma is expensive" is not something you can fix.
//
// The actionable number is how many queries a request issues, and which of them are asking for
// something that did not change since the last request. This prints exactly that.
//
//   npm run build && npm run bench:queries
//
// Requests are sent ONE AT A TIME on purpose. Concurrent requests interleave their queries in the
// log and there is no request id to separate them by, so the per-request attribution would be a
// guess. Throughput is irrelevant here; only the count is.

import { setUpstream, startHarness, COMPLETION_BODY, completionBody } from './gateway';

const REQUESTS = parseInt(process.env.QUERY_COUNT_REQUESTS ?? '10', 10);

/** Prisma writes `prisma:query <SQL>` to stdout when the client is built with log: ['query']. */
const QUERY_LINE = /^prisma:query\s+(.*)$/;

/**
 * Reduce a statement to what it is asking for, so repeats collapse together.
 *
 * Bound parameters are already placeholders in what Prisma logs, but whitespace and the exact
 * column list are not interesting — two SELECTs against the same table with the same WHERE shape
 * are the same question being asked twice, which is the thing worth finding.
 */
export function normalize(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const verb = /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|PRAGMA)/i.exec(flat)?.[1]?.toUpperCase() ?? 'OTHER';
  // Both engines qualify the table, and each quotes every part separately: SQLite writes
  // `main`.`NexusKey`, Postgres writes "public"."NexusKey". Capture the whole qualified name and
  // keep the LAST segment — the schema is the same for every row here and tells us nothing.
  const qualified = /(?:FROM|INTO|UPDATE)\s+([`"'\w.]+)/i.exec(flat)?.[1] ?? '';
  const table = qualified.replace(/[`"']/g, '').split('.').filter(Boolean).pop() ?? '';
  return table ? `${verb} ${table}` : verb;
}

async function main(): Promise<void> {
  // Set before the harness copies process.env into the child.
  process.env.PRISMA_LOG_QUERIES = '1';

  const h = await startHarness();
  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    // BENCH_SESSIONS=unique gives every request its own conversation, which forces a sticky MISS
    // and therefore the full routing sweep. The default keeps the old identical body, so the two can
    // be compared directly — the gap between them is what routing actually costs.
    const unique = process.env.BENCH_SESSIONS === 'unique';
    let n = 0;
    const send = (): Promise<Response> => fetch(`${h.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(unique ? completionBody(n++) : COMPLETION_BODY),
    });

    // Warm up first. The very first request pays one-time work — lazy config reads, a cold key
    // cache — that is genuinely not per-request, and counting it would overstate the steady state.
    for (let i = 0; i < 5; i++) await (await send()).text();

    // Let anything deferred (usage writes, tpm reconciliation) finish and be logged BEFORE the
    // mark, so it lands in the right window rather than smearing across it.
    await new Promise((r) => setTimeout(r, 1_500));

    const mark = h.log().length;
    for (let i = 0; i < REQUESTS; i++) await (await send()).text();
    // And again after, so the fire-and-forget writes this batch triggered are inside the window.
    await new Promise((r) => setTimeout(r, 2_000));

    const lines = h.log().slice(mark).split(/\r?\n/);
    const counts = new Map<string, number>();
    let total = 0;
    for (const line of lines) {
      const sql = QUERY_LINE.exec(line.trim())?.[1];
      if (!sql) continue;
      total++;
      const key = normalize(sql);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    if (total === 0) {
      console.log('No prisma:query lines captured. Query logging did not reach stdout — check that');
      console.log('PRISMA_LOG_QUERIES=1 survived into the child and that this is a fresh `npm run build`.');
      return;
    }

    // The grouped table says WHAT is being queried; it cannot say which call site issued it, and
    // two different code paths against the same table look identical in it. QUERY_COUNT_RAW=1
    // prints the statements themselves, which is how you tell a cache miss from a second caller.
    if (process.env.QUERY_COUNT_RAW === '1') {
      console.log('\n── raw statements ──');
      for (const line of lines) {
        const sql = QUERY_LINE.exec(line.trim())?.[1];
        if (sql) console.log(`  ${sql.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }

    console.log(`\n${total} queries over ${REQUESTS} requests — ${(total / REQUESTS).toFixed(1)} per request\n`);
    console.log('  per req   total   statement');
    for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${(n / REQUESTS).toFixed(1).padStart(7)}  ${String(n).padStart(6)}   ${key}`);
    }
    console.log('');
  } finally {
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
