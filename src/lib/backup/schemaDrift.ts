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

// Refusing a backup this gateway cannot honestly restore (Phase C4).
//
// ── What this replaces ────────────────────────────────────────────────────────────────────────
//
// Without it, a backup taken before a schema change fails partway through the restore with a Prisma
// error naming one column — after the tables have already been emptied, and with no indication of
// whether the file is bad, the gateway is wrong, or a column simply moved. The operator is left
// holding a file they cannot use and cannot diagnose.
//
// With it, the whole comparison happens before anything is touched, and the answer is a list.
//
// ── Not every difference is a problem, and saying so is the point ─────────────────────────────
//
// A guard that refused on ANY difference would refuse every backup taken before any release — which
// is a data-loss policy wearing the costume of caution. Most drift is additive and harmless:
//
//   a column this gateway added, with a default        the database fills it
//   a column this gateway added, nullable              it is null, which is what nullable means
//   a model this gateway added                         the file has no rows for it; nothing to do
//   a column that became optional                      a value still fits
//
// What genuinely cannot be honoured:
//
//   a column in the FILE this gateway no longer has    Prisma rejects the unknown argument
//   a column this gateway requires, with no default    there is nothing to put in it
//   a column whose TYPE changed                        the value in the file is the wrong shape
//   a column that became required, from optional       the file may hold nulls for it
//   a model in the file this gateway does not have     there is nowhere for the rows to go
//
// Tolerating the first group and refusing the second is what makes "a backup from v1.3 restores
// into v1.9" a sentence this product can say.

import type { SchemaShape } from './provenance';

export type DriftKind =
  | 'unknown-model'      // in the file, not here
  | 'new-model'          // here, not in the file
  | 'unknown-column'     // in the file, not here
  | 'missing-required'   // here and required with no default; the file cannot supply it
  | 'missing-fillable'   // here but absent from the file, and the database can fill it
  | 'type-changed'
  | 'now-required';      // was optional when written, required now

export interface Difference {
  model: string;
  /** Absent for a whole-model difference. */
  column?: string;
  kind: DriftKind;
  /** One line, phrased for an operator rather than a schema. */
  detail: string;
  /** Whether this alone makes the restore impossible. */
  blocking: boolean;
}

interface Column { name: string; type: string; required: boolean; defaultable: boolean }

/** `slug:String:req:nodef` → its parts. */
function parseColumn(descriptor: string): Column {
  const [name, type, required, defaultable] = descriptor.split(':');
  return { name, type, required: required === 'req', defaultable: defaultable === 'def' };
}

const byName = (shape: string[] = []): Map<string, Column> =>
  new Map(shape.map(parseColumn).map((c) => [c.name, c]));

/**
 * Every way the file's schema and this gateway's differ, worst first.
 *
 * Pure and total: it never throws and never reads anything outside its arguments, so the same
 * comparison drives the refusal, the dry-run report and the tests.
 */
export function compareSchemas(source: SchemaShape, here: SchemaShape): Difference[] {
  const out: Difference[] = [];

  for (const [model, sourceColumns] of Object.entries(source)) {
    if (!(model in here)) {
      out.push({
        model, kind: 'unknown-model', blocking: true,
        detail: `${model} is in the backup but not in this gateway — there is nowhere to put its rows.`,
      });
      continue;
    }

    const a = byName(sourceColumns);
    const b = byName(here[model]);

    for (const [name, from] of a) {
      const to = b.get(name);
      if (!to) {
        out.push({
          model, column: name, kind: 'unknown-column', blocking: true,
          detail: `${model}.${name} is in the backup but no longer exists here.`,
        });
        continue;
      }
      if (from.type !== to.type) {
        out.push({
          model, column: name, kind: 'type-changed', blocking: true,
          detail: `${model}.${name} was ${from.type} when this backup was taken and is ${to.type} now.`,
        });
        continue;
      }
      // A value that was allowed to be absent may be null in the file; a column that now insists on
      // one cannot take it. The reverse — required then, optional now — is always fine.
      if (!from.required && to.required && !to.defaultable) {
        out.push({
          model, column: name, kind: 'now-required', blocking: true,
          detail: `${model}.${name} was optional when this backup was taken and is now required with no default.`,
        });
      }
    }

    for (const [name, to] of b) {
      if (a.has(name)) continue;
      // Absent from the file. Fine if the database can produce a value — a default, an @updatedAt,
      // or simply being nullable. Otherwise there is nothing to insert and no way to invent it.
      const fillable = to.defaultable || !to.required;
      out.push({
        model, column: name, kind: fillable ? 'missing-fillable' : 'missing-required', blocking: !fillable,
        detail: fillable
          ? `${model}.${name} was added since this backup; it will take its default.`
          : `${model}.${name} is required here with no default, and this backup predates it.`,
      });
    }
  }

  for (const model of Object.keys(here)) {
    if (model in source) continue;
    out.push({
      model, kind: 'new-model', blocking: false,
      detail: `${model} did not exist when this backup was taken; it will be left empty.`,
    });
  }

  // Blocking first: an operator reads the top of a list.
  return out.sort((x, y) => Number(y.blocking) - Number(x.blocking));
}

export const blocking = (differences: readonly Difference[]): Difference[] =>
  differences.filter((d) => d.blocking);

/**
 * Raised when the schema moved too far for the file to be applied. Distinct from a damaged file and
 * from a timeout, because it is the only one where the right next step is "get the matching
 * version of the gateway" rather than "try again".
 */
export class SchemaDriftError extends Error {
  constructor(readonly differences: Difference[], sourceVersion: string) {
    const bad = blocking(differences);
    super(
      `This backup was taken from Alayra Nexus ${sourceVersion}, whose schema differs from this ` +
      `gateway's in ${bad.length} way${bad.length === 1 ? '' : 's'} that cannot be reconciled:\n` +
      bad.map((d) => `  • ${d.detail}`).join('\n') +
      '\n\nNothing was changed. Restore it into a gateway matching the version it came from, or ' +
      'export a fresh backup from one.');
    this.name = 'SchemaDriftError';
  }
}

/**
 * Refuse a backup whose schema this gateway cannot honour, before anything is touched.
 *
 * `source` is null for any backup written before C1. Those are reported as unverifiable rather than
 * refused: a file that predates the check has not failed it, and refusing every older backup would
 * destroy exactly the archive this feature exists to protect.
 */
export function assertRestorable(
  source: SchemaShape | null, here: SchemaShape, sourceVersion: string,
): Difference[] {
  if (!source) return [];
  const differences = compareSchemas(source, here);
  if (blocking(differences).length > 0) throw new SchemaDriftError(differences, sourceVersion);
  return differences;
}
