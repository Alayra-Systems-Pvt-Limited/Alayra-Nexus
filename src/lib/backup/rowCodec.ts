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

// Turning a database row into a line of JSON, and back (Phase B1.1).
//
// Plain `JSON.stringify` is not enough, for one reason that is easy to miss and produces a backup
// that restores WRONG rather than one that fails.
//
// ── The Date trap ─────────────────────────────────────────────────────────────────────────────
//
// `JSON.stringify` calls an object's `toJSON()` BEFORE handing the value to a replacer. `Date` has
// a `toJSON`, so by the time a replacer sees a timestamp it is already a plain ISO string — and
// therefore indistinguishable from a column that genuinely holds the text "2026-03-01T00:00:00Z".
// A reviver keyed on "looks like a date" would then convert real strings into Dates on restore.
//
// The fix is to read the RAW value through `this[key]`, which is the pre-`toJSON` object, and tag it
// explicitly. That requires a non-arrow function, since `this` is what makes it work.
//
// Tagged rather than inferred, throughout: a value's type is written down in the file instead of
// guessed at read time. There are 24 DateTime columns in this schema and every one of them lands in
// a row that must come back as a Date, because Prisma rejects a string where it expects one.
//
// ── BigInt ────────────────────────────────────────────────────────────────────────────────────
//
// No column in the schema is BigInt today, so this is defensive — but `JSON.stringify` THROWS on a
// BigInt rather than skipping it, which would abort an export part-way with an error naming neither
// the table nor the row. S2.1 already found SQLite returning BigInt where Postgres returned a
// number (`MAX("createdAt")` in the team-member query), so the possibility is not theoretical.

/** A value that was a Date in the database. */
interface DateTag { $d: string }
/** A value that was a BigInt. */
interface BigIntTag { $n: string }

const isDateTag = (v: unknown): v is DateTag =>
  typeof v === 'object' && v !== null && typeof (v as DateTag).$d === 'string' && Object.keys(v).length === 1;

const isBigIntTag = (v: unknown): v is BigIntTag =>
  typeof v === 'object' && v !== null && typeof (v as BigIntTag).$n === 'string' && Object.keys(v).length === 1;

/**
 * NOT an arrow function, and that is the whole point: `this` is the object being serialised, so
 * `this[key]` is the value BEFORE `toJSON()` flattened it.
 */
function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this?.[key];
  if (raw instanceof Date) return { $d: raw.toISOString() };
  if (typeof raw === 'bigint') return { $n: raw.toString() };
  return value;
}

/** One row as a single line of JSON, with types preserved. Never contains a newline. */
export function encodeRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, replacer);
}

/** Walk a parsed value and turn the tags back into the types they stand for. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (isDateTag(value)) {
    const d = new Date(value.$d);
    if (Number.isNaN(d.getTime())) throw new Error(`Backup contains an unreadable date: ${value.$d}`);
    return d;
  }
  if (isBigIntTag(value)) return BigInt(value.$n);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v);
    return out;
  }
  return value;
}

/** Read one line back into a row, restoring Dates and BigInts. */
export function decodeRow(line: string): Record<string, unknown> {
  const parsed = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Backup contains a line that is not a row object.');
  }
  return revive(parsed) as Record<string, unknown>;
}
