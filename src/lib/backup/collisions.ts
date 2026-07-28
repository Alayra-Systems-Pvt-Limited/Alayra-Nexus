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

// Which rows a `merge` restore will silently refuse to insert (Phase A1).
//
// ── The defect this exists to make visible ────────────────────────────────────────────────────
//
// `createMany({ skipDuplicates: true })` skips a row that violates ANY unique constraint, not only
// the primary key. That is not what the word "duplicate" suggests, and it is not what merge means.
//
// Proven on a live database: two rows with different ids but the same `slug` gave
// `inserted: 0 | rows now: 1`. The second row was dropped. The insert reported success, the restore
// reported success, and the HTTP response was 200. The only trace was a `written` count nobody
// compared against anything.
//
// So an operator merging one gateway's data into another can lose rows — the exact rows most likely
// to matter, since a colliding slug or email means the two gateways were describing the same thing —
// and be told it worked.
//
// ── Why the answer is a dry run and not a better insert ───────────────────────────────────────
//
// `createMany` returns a count and nothing else. It cannot say WHICH rows it skipped or why, and
// there is no variant that can. Row-at-a-time inserts could tell us, but only by discovering it
// during the restore, when the transaction is already open and the honest response — "stop, look at
// this" — is no longer available.
//
// The dry run already reads and authenticates the whole file and writes nothing. It is the only
// place where the answer is both knowable and still actionable.
//
// ── Cost is deliberately bounded to the small tables ──────────────────────────────────────────
//
// Only seven of the sixteen models carry a unique column, and `tokenUsage` — by far the largest —
// is not one of them. So this never touches the big table, and the work is proportional to the part
// of the schema that can actually collide. That is why the check is driven by the registry below
// rather than by "every model in the file".

/** A unique column, and whether its values may be shown back to the operator. */
export interface UniqueColumn {
  /** Prisma delegate name, matching MODEL_ORDER. */
  model: string;
  column: string;
  /**
   * Hashed credentials. The count is reported; the values never are.
   *
   * They are hashes, so echoing one is not handing over a credential — but a backup report is not
   * the place to start printing the contents of the columns whose whole purpose is that a stolen
   * database yields nothing usable.
   */
  sensitive: boolean;
}

/**
 * Every single-column unique constraint in the schema, for models that are backed up.
 *
 * Hand-written so it can be reviewed, and checked against prisma/schema.prisma by
 * `collisions.test.ts` — which fails the build if a constraint is added, removed, or renamed and
 * this list is not updated. Without that test this file rots into a check that quietly stops
 * checking the one column somebody just added.
 *
 * There are no composite (`@@unique`) constraints in this schema today. The test fails if one
 * appears, because a composite needs a different query shape than the one below.
 */
export const UNIQUE_COLUMNS: readonly UniqueColumn[] = [
  { model: 'nexusProvider',     column: 'slug',      sensitive: false },
  { model: 'appSettings',       column: 'key',       sensitive: false },
  { model: 'adminUser',         column: 'email',     sensitive: false },
  { model: 'domainAlias',       column: 'domain',    sensitive: false },
  { model: 'nexusTeamKey',      column: 'keyHash',   sensitive: true  },
  { model: 'adminInvite',       column: 'tokenHash', sensitive: true  },
  { model: 'adminRecoveryCode', column: 'codeHash',  sensitive: true  },
  { model: 'adminApiToken',     column: 'tokenHash', sensitive: true  },
] as const;

/** How many colliding values to quote back. Enough to recognise the problem, not a data dump. */
export const MAX_EXAMPLES = 5;

/** Models worth checking at all — the rest cannot collide on anything but their primary key. */
export const MODELS_WITH_UNIQUE_COLUMNS: ReadonlySet<string> = new Set(UNIQUE_COLUMNS.map((c) => c.model));

/** One unique column on which the file disagrees with what is already here. */
export interface Collision {
  model: string;
  column: string;
  /** Rows that would be silently dropped. Exact, not sampled. */
  count: number;
  /** Up to MAX_EXAMPLES offending values. Always empty for a sensitive column. */
  examples: string[];
}

/** The one method this needs from a Prisma model delegate, named structurally. */
export interface CollisionDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }): Promise<Record<string, unknown>[]>;
}

/** Just enough of a Prisma client to reach the delegates by name. */
export type CollisionClient = Record<string, unknown>;

/**
 * Which of these rows carry a unique value that already belongs to a DIFFERENT row here.
 *
 * Same id and same value is not a collision — that is the same row arriving twice, which is exactly
 * what merge is meant to skip. The dangerous case is a different id wearing a value that is already
 * taken, because that row is not a duplicate of anything: it is data, and it will vanish.
 *
 * Reads only. Safe to call outside a transaction, which is where the dry run runs it.
 */
export async function findCollisions(
  client: CollisionClient,
  model: string,
  rows: readonly Record<string, unknown>[],
): Promise<Collision[]> {
  const columns = UNIQUE_COLUMNS.filter((c) => c.model === model);
  if (columns.length === 0 || rows.length === 0) return [];

  const delegate = client[model] as CollisionDelegate | undefined;
  if (!delegate?.findMany) throw new Error(`This gateway has no "${model}" table.`);

  const out: Collision[] = [];

  for (const { column, sensitive } of columns) {
    /**
     * Value → the id of the row in the FILE carrying it.
     *
     * A value appearing twice within one batch would overwrite here. That cannot happen in a file
     * written by an export, because the source database enforced the same constraint — and a file
     * altered by hand does not authenticate. Schema drift could in principle produce one; that is
     * B4's problem, and it refuses the file outright rather than reasoning about its contents.
     */
    const byValue = new Map<unknown, string>();
    for (const row of rows) {
      const value = row[column];
      // NULL never violates a unique index — on either engine, any number of rows may hold it.
      if (value === undefined || value === null) continue;
      byValue.set(value, String(row.id));
    }
    if (byValue.size === 0) continue;

    const existing = await delegate.findMany({
      where: { [column]: { in: [...byValue.keys()] } },
      select: { id: true, [column]: true },
    });

    const examples: string[] = [];
    let count = 0;

    for (const row of existing) {
      const idInFile = byValue.get(row[column]);
      if (idInFile === undefined) continue;
      if (String(row.id) === idInFile) continue;   // the same row, arriving again — merge skips it correctly

      count++;
      if (!sensitive && examples.length < MAX_EXAMPLES) examples.push(String(row[column]));
    }

    if (count > 0) out.push({ model, column, count, examples });
  }

  return out;
}

/** Fold per-batch results together, so one model+column is reported once with a total. */
export function mergeCollisions(into: Collision[], found: readonly Collision[]): void {
  for (const c of found) {
    const existing = into.find((e) => e.model === c.model && e.column === c.column);
    if (!existing) { into.push({ ...c, examples: [...c.examples] }); continue; }
    existing.count += c.count;
    for (const ex of c.examples) {
      if (existing.examples.length >= MAX_EXAMPLES) break;
      if (!existing.examples.includes(ex)) existing.examples.push(ex);
    }
  }
}
