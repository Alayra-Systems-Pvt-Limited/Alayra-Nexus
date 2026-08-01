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

// Judging a Postgres address before anything is done to it (Phase S3).
//
// Pure, like lib/backupSchedule next to its service: everything here decides from arguments alone
// and is tested without a database. The I/O lives in services/pgMigrate.service.ts.
//
// The refusals are written for somebody who has just pasted a string out of a hosting dashboard and
// is one step from moving their production data. Each one says what is wrong AND what to do, because
// "invalid connection string" at this moment is the difference between a migration and a support
// ticket.

import { MODEL_ORDER, EXCLUDED_MODELS } from './backup/modelOrder';

/** Schemes a Postgres connection string may use. Prisma accepts both spellings. */
const POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:']);

/**
 * Why this address cannot be used, in words an operator can act on — or null when it looks usable.
 *
 * "Looks usable" is all this can promise: whether the server answers is a question for the network,
 * not for a parser. It exists to catch the mistakes that are obvious from the text alone, so the
 * operator hears about them immediately rather than after a thirty-second connection timeout.
 */
export function targetUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return 'Paste the connection string for the Postgres database you are moving to.';

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'That is not a connection string. It should look like postgresql://user:password@host:5432/databasename.';
  }

  if (!POSTGRES_SCHEMES.has(url.protocol)) {
    // Named explicitly rather than "unsupported scheme": someone pasting a file: path is trying to
    // migrate to SQLite, which is the direction this screen does not go, and saying so is kinder
    // than a generic refusal.
    if (url.protocol === 'file:') {
      return 'That is a SQLite file, which is what this gateway is moving away from. Paste a Postgres address instead.';
    }
    return `This gateway moves to PostgreSQL, and that address is for ${url.protocol.replace(':', '')}. It should begin with postgresql://.`;
  }

  if (!url.hostname) return 'That address has no host. It should look like postgresql://user:password@host:5432/databasename.';

  // Prisma reads the first path segment as the database name; without one it connects to a default
  // named after the user, which is almost never what somebody meant and is very hard to notice
  // afterwards.
  const database = url.pathname.replace(/^\//, '');
  if (database.length === 0) {
    return 'That address does not name a database. Add it to the end, as in postgresql://user:password@host:5432/databasename.';
  }

  if (!url.username) {
    return 'That address has no username, so the gateway cannot sign in to it. It should look like postgresql://user:password@host:5432/databasename.';
  }

  return null;
}

/**
 * Prisma's failure, reduced to the part an operator can act on.
 *
 * Prisma prefaces connection errors with the call that failed —
 * "Invalid `prisma.$queryRaw()` invocation:" — and then blank lines, before reaching the sentence
 * that actually says what is wrong. Shown verbatim it reads as an internal error, and the person
 * looking at it concludes the product is broken rather than that they typed the wrong host. The
 * useful sentence is kept; the stack-trace framing is not.
 *
 * Deliberately conservative: anything it does not recognise passes through untouched, because a
 * message nobody predicted is still better than one that has been trimmed to nothing.
 */
export function readableDbError(raw: string): string {
  const text = raw
    .replace(/Invalid `[^`]*` invocation:?/gi, '')
    .replace(/^\s*in \S+:\d+:\d+\s*$/gim, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return text.length > 0 ? text : raw.trim();
}

/** The address with anything secret removed, safe for a screen, a log or an audit record. */
export function describeTarget(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const database = url.pathname.replace(/^\//, '');
    const port = url.port ? `:${url.port}` : '';
    return `${url.hostname}${port}/${database}`;
  } catch {
    return 'the database you named';
  }
}

/**
 * The models a migration carries, in the order rows must be written.
 *
 * Reuses the backup's own order rather than a second list: it is parents-first, it is checked
 * against the schema by `modelOrder.test.ts`, and a migration inserting a child before its parent
 * fails on a foreign key exactly as a restore would.
 */
export const MIGRATE_ORDER: readonly string[] = MODEL_ORDER;

/**
 * Stored backups do not travel, and this is deliberate.
 *
 * They are the one table that can be larger than everything else combined, and they are recoverable
 * artefacts rather than live configuration — the gateway starts taking new ones on its own schedule
 * the moment it is running on Postgres. Copying them could turn a two-minute move into a twenty-
 * minute one, over a connection that may be metered, for data the operator can still download from
 * the old gateway: the SQLite file is never deleted by this process.
 *
 * The screen says this in as many words. A migration that silently dropped somebody's backup history
 * would be a surprise discovered at the worst possible time, which is the failure this whole feature
 * exists to prevent.
 */
export const NOT_MIGRATED: readonly string[] = EXCLUDED_MODELS;

/** Row counts per model, as both sides report them. */
export type TableCounts = Record<string, number>;

export interface CountMismatch {
  model: string;
  source: number;
  target: number;
}

/**
 * Compare what the source held with what arrived.
 *
 * The whole point of the verify step: "migrated" is a claim about every row, and the only honest
 * way to make it is to count both sides afterwards. A model missing from `target` counts as zero
 * rather than being skipped — an absent table is the most serious version of this failure, and
 * treating it as "nothing to compare" would report success for it.
 */
export function countMismatches(source: TableCounts, target: TableCounts): CountMismatch[] {
  const out: CountMismatch[] = [];
  for (const model of Object.keys(source)) {
    const from = source[model] ?? 0;
    const to = target[model] ?? 0;
    if (from !== to) out.push({ model, source: from, target: to });
  }
  return out;
}

/** Total rows across every model, for progress reporting. */
export const totalRows = (counts: TableCounts): number =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);
