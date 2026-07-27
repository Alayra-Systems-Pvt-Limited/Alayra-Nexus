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

// Making a SQLite file behave like a server's database (Phase S2.5).
//
// SQLite opens in `delete` journal mode, where a write takes a lock over the WHOLE database and
// every reader waits for it. That is the right default for the thing SQLite is usually embedded in —
// one process, one thread, occasional writes. It is the wrong default for this gateway, which writes
// continuously in the background (the usage pipeline, the audit buffer, the health sampler) while
// serving dashboard reads.
//
// WAL changes exactly that: readers see the last committed snapshot and never block on a writer, and
// the writer never waits for readers.
//
// MEASURED, not assumed — six concurrent dashboard aggregates over 120k rows with 60 background
// writes landing during them, repeated four times (scripts/bench/sqliteJournal.ts):
//
//                total        slowest background write
//     delete    ~2100ms        ~2000ms
//     wal        ~600ms         ~260ms
//
// Note what the failure actually looks like, because it is not what one expects. At this load
// `delete` loses nothing — busy_timeout absorbs the contention as LATENCY, so a background write
// simply waits ~2s behind a dashboard query and then succeeds. The errors begin only once something
// waits past the 5s timeout, at which point it fails with SQLITE_BUSY. So the symptom sequence under
// growing load is "the dashboard feels slow", then "usage rows go missing" — and the first is the
// only warning of the second.
//
// ── The limit of this, so nobody assumes more than it does ─────────────────────────────────────
//
// WAL does NOT make interactive transactions concurrent. Prisma's `$transaction` takes a write lock
// on SQLite up front, even when the body only reads, so two overlapping `$transaction` calls
// serialise in WAL exactly as they do in `delete` — measured at the full 5s busy_timeout, then
// "database is locked". SQLite has one writer at a time and no journal mode changes that. What WAL
// fixes is the far more common case here: plain autocommit reads and writes overlapping, which is
// what every dashboard query and every buffered flush actually is.
//
// ── What this module deliberately does NOT set, and why ────────────────────────────────────────
//
// Established by probing a real generated client rather than from documentation, because the
// difference between "persistent" and "per-connection" decides whether setting something once is a
// fix or a hazard:
//
//   busy_timeout   Prisma already sets it to 5000ms on EVERY pooled connection. Setting it again
//                  would be a no-op we would then have to keep true.
//   foreign_keys   Already ON, and verified by behaviour, not by reading the pragma back: inserting
//                  a child row with no parent raises SQLITE_CONSTRAINT (787).
//   synchronous    NOT SET, on purpose. It is per-connection and Prisma pools several — a probe
//                  issuing twelve concurrent reads got TWO different values back after setting it
//                  once. So it cannot be set reliably from here at all, and half-setting it would
//                  produce a database where some commits are flushed to disk and some are not.
//                  That is worse than either consistent answer. FULL (SQLite's default) is the
//                  slower and safer of the two, and it is where we leave it.
//
// journal_mode is the exception that makes this module possible: it is written into the database
// FILE HEADER, not held per connection, so one call configures every connection that will ever open
// the file — including the ones Prisma opens later, and any second process.

import type { PrismaClient } from '@prisma/client';

/** What the file is actually set to now — not what we asked for. */
export interface SqliteTuning {
  /** The mode in force after the attempt: "wal" when it worked, otherwise whatever it stayed at. */
  journalMode: string | null;
  /** True only when the file is genuinely in WAL. */
  wal: boolean;
  /** Present when WAL could not be enabled, in words an operator can act on. */
  warning?: string;
}

/**
 * Ask SQLite for WAL, and report what it actually gave us.
 *
 * `PRAGMA journal_mode = …` is a query, not a statement: it RETURNS the mode in force after the
 * change. That return value is the whole point of this function — SQLite refuses WAL on a
 * filesystem without shared-memory support (NFS, SMB, some container volume drivers) and answers by
 * quietly leaving the mode alone rather than raising. Code that issued the pragma and moved on would
 * believe it had concurrency it does not have, and the first evidence would be SQLITE_BUSY under
 * load in production.
 *
 * Never throws. A gateway that cannot be tuned is degraded, not broken, and refusing to boot over it
 * would turn a performance caveat into an outage.
 */
export async function configureSqlite(client: PrismaClient): Promise<SqliteTuning> {
  let mode: string | null = null;

  try {
    // $queryRawUnsafe, not $executeRawUnsafe: this returns a row, and the execute path rejects
    // statements that produce results.
    const rows = await client.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode = WAL`);
    mode = rows[0]?.journal_mode?.toLowerCase() ?? null;
  } catch (e) {
    return {
      journalMode: null,
      wal: false,
      warning:
        `Could not set the SQLite journal mode (${(e as Error).message}). The gateway works, but ` +
        `readers will block on writers under load.`,
    };
  }

  if (mode === 'wal') return { journalMode: mode, wal: true };

  return {
    journalMode: mode,
    wal: false,
    warning:
      `SQLite stayed in "${mode ?? 'unknown'}" journal mode instead of WAL. This normally means the ` +
      `database file is on a filesystem without shared-memory support — a network mount (NFS, SMB) ` +
      `or some container volume drivers. The gateway works, but a write blocks every read for its ` +
      `duration. Move the file to local disk to fix it.`,
  };
}

// ── Why there is no checkpointSqlite() here ───────────────────────────────────────────────────
//
// There was one, wired into the server's shutdown to fold the -wal back into the database so a
// stopped gateway left one file in .nexus/ rather than three. It was deleted after being measured:
// `prisma.$disconnect()` closes the last connection, and SQLite checkpoints and REMOVES both the
// -wal and the -shm as part of a clean close. Written down here because the reasoning for adding it
// is entirely plausible, and without this note the obvious next step on reading the shutdown path is
// to add it back.
//
//   200 rows written, journal_mode=wal, then $disconnect() with no explicit checkpoint:
//     while open        n.db=8192  n.db-shm=32768  n.db-wal=824032
//     after disconnect  n.db=8192
//
// The two cases it looked like insurance against are not ones it helps with either: on a clean exit
// SQLite has already done it, and on a SIGKILL or an uncaught exception the shutdown handler never
// runs at all. A -wal left behind by a hard kill is not a problem to solve here in any case — it is
// a legitimate part of the database and the next open replays it.
//
// A checkpoint DOES become necessary the moment something copies the database file at the byte level
// — a file-level snapshot must not race an unmerged log. Nothing does that today; the backup work
// (B1) is logical, reading rows through Prisma, so it will not need one either.
