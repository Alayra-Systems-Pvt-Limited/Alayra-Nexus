/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Does the Health panel's database card report real facts on both engines? (Phase S2.3)
//
// The seven pg_catalog queries were each `.catch(() => [])`-guarded, so on SQLite nothing broke —
// every fact simply came back null and the panel rendered a wall of "—". That is the failure this
// file exists to prevent recurring: a null has to mean "this engine genuinely has no such concept",
// never "the query failed and nobody noticed".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEngines, seedBoth, PARITY_DATABASE_URL, type Engines } from './harness';
import { readDbStats } from '../dbStats';

const enabled = !!PARITY_DATABASE_URL;

describe.skipIf(!enabled)('database stats are real on both engines', () => {
  let e: Engines;

  beforeAll(async () => { e = startEngines('stats'); await seedBoth(e); }, 120_000);
  afterAll(async () => { await e?.dispose(); });

  it('both engines return every field — a branch cannot silently omit one', async () => {
    const pg = await readDbStats(e.pg, 'postgres');
    const sq = await readDbStats(e.sqlite, 'sqlite');
    expect(Object.keys(sq).sort()).toEqual(Object.keys(pg).sort());
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: reports its own version', async (engine) => {
    const s = await readDbStats(engine === 'sqlite' ? e.sqlite : e.pg, engine);
    expect(s.version).toBeTruthy();
    expect(s.version).toMatch(/^\d+\.\d+/);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: reports a plausible database size', async (engine) => {
    const s = await readDbStats(engine === 'sqlite' ? e.sqlite : e.pg, engine);
    expect(s.databaseBytes).toBeGreaterThan(0);
    // A seeded schema is not megabytes and not a handful of bytes. Bounds catch a unit slip —
    // pages counted as bytes, or bytes reported as kilobytes.
    expect(s.databaseBytes!).toBeGreaterThan(4_000);
    expect(s.databaseBytes!).toBeLessThan(200_000_000);
  });

  it.each([['postgres'], ['sqlite']] as const)('%s: names the largest tables with real row counts', async (engine) => {
    const s = await readDbStats(engine === 'sqlite' ? e.sqlite : e.pg, engine);

    expect(s.largestTables.length).toBeGreaterThan(0);
    expect(s.largestTables.length).toBeLessThanOrEqual(5);

    // Descending by size, like the panel's bar chart assumes.
    const sizes = s.largestTables.map((t) => t.bytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);

    // Real table names, not index names. dbstat lists one row per B-tree, so a missing join to
    // sqlite_master would surface "TokenUsage_createdAt_idx" as though it were a table.
    for (const t of s.largestTables) {
      expect(t.name).not.toMatch(/_idx$|_key$/);
      expect(t.name.startsWith('sqlite_')).toBe(false);
      expect(t.bytes).toBeGreaterThan(0);
      expect(t.rows).toBeGreaterThanOrEqual(0);
    }
  });

  it('sqlite: row counts are exact, not estimates', async () => {
    // Postgres reports n_live_tup, which is an estimate and can lag. SQLite has no such counter, so
    // this is COUNT(*) and must therefore be exactly right — a wrong number here is a bug, not drift.
    const s = await readDbStats(e.sqlite, 'sqlite');
    const usage = s.largestTables.find((t) => t.name === 'TokenUsage');
    expect(usage).toBeDefined();
    expect(usage!.rows).toBe(await e.sqlite.tokenUsage.count());
    expect(usage!.rows).toBe(12);
  });

  it('sqlite: reports the file facts an operator of a single-file database acts on', async () => {
    const s = await readDbStats(e.sqlite, 'sqlite');

    // Journal mode decides whether a reader blocks during a write — the single most consequential
    // setting for a file-backed gateway, and invisible anywhere else in the product.
    expect(s.journalMode).toBeTruthy();
    expect(['delete', 'wal', 'truncate', 'persist', 'memory', 'off']).toContain(s.journalMode!.toLowerCase());

    expect(s.pageSize).toBeGreaterThan(0);
    expect(s.reclaimableBytes).not.toBeNull();
    expect(s.reclaimableBytes).toBeGreaterThanOrEqual(0);
    // Free space cannot exceed the file it is inside.
    expect(s.reclaimableBytes!).toBeLessThanOrEqual(s.databaseBytes!);
  });

  it('sqlite: is null about the things a file genuinely does not have', async () => {
    // The assertion that keeps the panel honest. These are not failed readings — SQLite is a file
    // opened by one process, so there is no connection pool, no server-side buffer cache and no
    // cumulative transaction counter. Reporting 0 would be a lie; null is the truth, and the UI is
    // what has to explain it.
    const s = await readDbStats(e.sqlite, 'sqlite');
    expect(s.maxConnections).toBeNull();
    expect(s.connections).toBeNull();
    expect(s.cacheHitRatio).toBeNull();
    expect(s.commits).toBeNull();
    expect(s.rollbacks).toBeNull();
    expect(s.deadlocks).toBeNull();
    expect(s.tempBytes).toBeNull();
    expect(s.longestTxnSeconds).toBeNull();
  });

  it('postgres: still reports everything it did before — nothing was lost in the move', async () => {
    const s = await readDbStats(e.pg, 'postgres');
    expect(s.maxConnections).toBeGreaterThan(0);
    expect(s.connections).not.toBeNull();
    expect(s.connections!.total).toBeGreaterThan(0);
    expect(s.commits).toBeGreaterThan(0);
    expect(s.rollbacks).not.toBeNull();
    expect(s.deadlocks).not.toBeNull();
    expect(s.cacheHitRatio).toBeGreaterThan(0);
    expect(s.cacheHitRatio).toBeLessThanOrEqual(1);
  });

  it('postgres: is null about the things only a single file has', async () => {
    const s = await readDbStats(e.pg, 'postgres');
    expect(s.journalMode).toBeNull();
    expect(s.pageSize).toBeNull();
    expect(s.reclaimableBytes).toBeNull();
  });

  it('never throws, and never returns a BigInt, even against a broken client', async () => {
    // The panel is a read: a database that cannot answer must cost the numbers, never the page.
    const broken = {
      $queryRaw:       () => Promise.reject(new Error('connection refused')),
      $queryRawUnsafe: () => Promise.reject(new Error('connection refused')),
    } as unknown as Parameters<typeof readDbStats>[0];

    for (const engine of ['postgres', 'sqlite'] as const) {
      const s = await readDbStats(broken, engine);
      expect(s.version).toBeNull();
      expect(s.databaseBytes).toBeNull();
      expect(s.largestTables).toEqual([]);
    }

    for (const [engine, db] of [['postgres', e.pg], ['sqlite', e.sqlite]] as const) {
      const s = await readDbStats(db, engine);
      expect(() => JSON.stringify(s)).not.toThrow();
      for (const [k, v] of Object.entries(s)) {
        expect(typeof v, `${engine}.${k} is a BigInt`).not.toBe('bigint');
      }
    }
  });
});
