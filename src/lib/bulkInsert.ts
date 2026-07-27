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

// An idempotent batched insert, on either engine (Phase S2.2).
//
// Both buffered writers — the audit trail and the usage pipeline — insert in batches and re-queue
// the batch when the insert fails. That retry is only safe because the insert is idempotent:
// `skipDuplicates` makes re-inserting a batch that partly landed a no-op rather than a unique-key
// violation. Ids are UUIDs, so a duplicate can only ever be a row we already wrote.
//
// SQLite has no `skipDuplicates`. Not merely unimplemented at runtime — it is absent from the
// generated client's types, so passing it raises a validation error rather than a database error.
// That matters more than it looks: `audit.service.flush()` catches every error by re-queueing, so
// on SQLite the batch would fail, be re-queued, fail again, and keep failing until the buffer hit
// its cap and started shedding audit records. A silent, permanent loss of the compliance trail.
//
// The fallback is per-row inserts that swallow only unique violations. It costs one round-trip per
// row, which is why it runs ONLY after a batch actually collided — the common path is still a
// single batched insert on both engines.

import { dbEngine } from './prisma';
import type { DbEngine } from './mode';

/** The two methods this needs from a Prisma model delegate, named structurally. */
export interface BulkDelegate<Row> {
  createMany(args: { data: Row[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  create(args: { data: Row }): Promise<unknown>;
}

/**
 * P2002 is Prisma's unique-constraint violation, on every engine.
 *
 * Checked STRUCTURALLY, never with `instanceof PrismaClientKnownRequestError`. There are two
 * generated clients here, each carrying its own copy of the Prisma runtime and therefore its own
 * distinct error classes — so an error thrown by the SQLite client is not an `instanceof` the class
 * exported by `@prisma/client`, and the check silently returns false for every SQLite error.
 *
 * This was written with `instanceof` first and the parity suite caught it. The consequence would
 * have been invisible and serious: on SQLite every duplicate would have been rethrown, the audit
 * writer would have re-queued the same batch forever, and the compliance trail would have filled
 * its buffer and started shedding records — which is the exact failure this module exists to stop.
 */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

/**
 * Insert every row, treating one that is already there as done rather than as an error.
 *
 * Returns the number of rows newly written — which on the fallback path is genuinely fewer than
 * `rows.length`, and is the honest answer. Any error that is NOT a duplicate is rethrown, because
 * a connection failure or a constraint we did not anticipate must still reach the caller's retry.
 */
export async function createManyIgnoringDuplicates<Row>(
  delegate: BulkDelegate<Row>,
  rows: Row[],
  /**
   * Which engine the delegate belongs to. Defaults to the gateway's own, which is what every
   * production caller wants and keeps their call sites unchanged.
   *
   * It is a parameter at all because module state can only ever describe ONE engine per process,
   * and two callers need otherwise: the parity suite, which drives a real PostgreSQL and a real
   * SQLite in the same run, and restore, which is handed a client rather than importing one. Before
   * this existed the parity test held a hand-copied mirror of the logic below — a second
   * implementation that could drift from this one while both stayed green, which is precisely the
   * failure this file was written to prevent.
   */
  engine: DbEngine = dbEngine,
): Promise<number> {
  if (rows.length === 0) return 0;

  if (engine !== 'sqlite') {
    const { count } = await delegate.createMany({ data: rows, skipDuplicates: true });
    return count;
  }

  // SQLite: try the batch, and only pay for row-at-a-time if it actually collided.
  try {
    const { count } = await delegate.createMany({ data: rows });
    return count;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  let written = 0;
  for (const row of rows) {
    try {
      await delegate.create({ data: row });
      written++;
    } catch (e) {
      // Already present — which is exactly the case this function exists to tolerate. Anything
      // else is a real failure and must not be swallowed into a smaller count.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return written;
}
