/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Do the two generated clients still describe the same database? (Phase S2)
//
// lib/prisma.ts casts the SQLite client to the Postgres client's type, because 30 call sites should
// not have to care which one they got. A cast silences the compiler, so something else has to do
// the checking — that is this file. It compares the two clients' DMMF, which is what Prisma actually
// generated, rather than the schema text they were generated from: a drift check on the source
// would pass happily if the generator itself started treating a type differently per engine.
//
// Deliberately NOT skipped when the SQLite client is missing. A parity suite that quietly skips is
// worse than no parity suite: it reports green while checking nothing, which is the exact failure
// this whole approach exists to prevent.

import { describe, it, expect } from 'vitest';
import { Prisma as PgPrisma } from '@prisma/client';
import { SQLITE_CLIENT_SPECIFIER } from './prisma';

type Dmmf = typeof PgPrisma.dmmf;

function loadSqliteDmmf(): Dmmf {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require(SQLITE_CLIENT_SPECIFIER) as { Prisma: { dmmf: Dmmf } }).Prisma.dmmf;
  } catch (e) {
    throw new Error(
      `The SQLite client is not generated, so engine parity cannot be checked. ` +
      `Run \`npm run db:generate\`. (${(e as Error).message.split('\n')[0]})`,
    );
  }
}

/** `Model.field:Type!` — name, type, nullability and list-ness, which is everything a caller sees. */
const signature = (d: Dmmf): string[] =>
  d.datamodel.models
    .flatMap((m) => m.fields.map((f) => `${m.name}.${f.name}:${f.type}${f.isRequired ? '!' : '?'}${f.isList ? '[]' : ''}`))
    .sort();

describe('the Postgres and SQLite clients describe the same database', () => {
  const pg = PgPrisma.dmmf;
  const sq = loadSqliteDmmf();

  it('generated a non-trivial model set — guards the comparison itself', () => {
    // Without this, two empty DMMFs would "match" and every assertion below would pass vacuously.
    expect(pg.datamodel.models.length).toBeGreaterThan(10);
    expect(signature(pg).length).toBeGreaterThan(100);
  });

  it('has the same models', () => {
    const names = (d: Dmmf) => d.datamodel.models.map((m) => m.name).sort();
    expect(names(sq)).toEqual(names(pg));
  });

  it('has the same fields, types, nullability and list-ness on every model', () => {
    // A field that is required on one engine and optional on the other is the quiet kind of drift:
    // both schemas stay valid, and a write that succeeds in server mode fails in standalone.
    expect(signature(sq)).toEqual(signature(pg));
  });

  it('has the same unique constraints and ids', () => {
    const keys = (d: Dmmf) =>
      d.datamodel.models
        .map((m) => `${m.name}: id=${m.fields.filter((f) => f.isId).map((f) => f.name).join('+') || '-'} ` +
                    `unique=${m.fields.filter((f) => f.isUnique).map((f) => f.name).sort().join(',') || '-'}`)
        .sort();
    expect(keys(sq)).toEqual(keys(pg));
  });

  it('has the same relations, so a cascade cannot differ by engine', () => {
    // Cascade rules are enforcement, not decoration: NexusKey cascades from Team specifically so
    // deleting a team destroys its BYOK credentials rather than releasing them into the shared pool.
    const rels = (d: Dmmf) =>
      d.datamodel.models
        .flatMap((m) => m.fields.filter((f) => f.relationName)
          .map((f) => `${m.name}.${f.name} -> ${f.type} (${f.relationName}, onDelete=${f.relationOnDelete ?? 'default'})`))
        .sort();
    expect(rels(sq)).toEqual(rels(pg));
  });

  it('has the same default values', () => {
    // A default that exists on one engine and not the other turns an omitted column into a null on
    // exactly one of them — e.g. TokenUsage.outcome, which every analytics aggregate filters on.
    const defs = (d: Dmmf) =>
      d.datamodel.models
        .flatMap((m) => m.fields.filter((f) => f.hasDefaultValue)
          .map((f) => `${m.name}.${f.name}=${JSON.stringify(f.default)}`))
        .sort();
    expect(defs(sq)).toEqual(defs(pg));
  });
});
