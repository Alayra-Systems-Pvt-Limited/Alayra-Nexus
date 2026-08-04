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
//
// ── What Prisma 7 took away, and what replaced it ─────────────────────────────────────────────
//
// A v7 DMMF field is `{name, kind, type}`, plus `relationName` on a relation. `isRequired`, `isList`,
// `isId`, `isUnique`, `hasDefaultValue`, `default` and `relationOnDelete` are all gone.
//
// Read through the previous version of this file, that did NOT fail. Both engines lost the same
// properties, so every comparison still matched — while checking nothing. `has the same default
// values` compared two empty lists; `has the same unique constraints and ids` compared "id=- unique=-"
// against itself for every model; the `!`/`?` in each signature became `?` everywhere. Five
// assertions went green and vacuous at once, which is precisely the failure the paragraph above
// says this file exists to prevent.
//
// So the comparisons that the DMMF can no longer support are made against the two SCHEMA FILES
// instead, through the reader in scripts/db/columnFacts.ts. That is a step back towards the source
// the header warns about — with the mitigation that `sqliteSchema.test.ts` proves the SQLite schema
// is DERIVED from the Postgres one and differs by exactly two lines, so "the generator started
// treating a type differently per engine" is a claim that file already tests directly.
//
// And `the DMMF still carries what these comparisons read` below is the guard that makes this
// visible next time: if a future Prisma removes another property, that test fails instead of the
// suite silently thinning out again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma as PgPrisma } from '@prisma/client';
import { SQLITE_CLIENT_SPECIFIER } from './prisma';
import { parseColumnFacts, parseModelKeys } from '../../scripts/db/columnFacts';

type Dmmf = typeof PgPrisma.dmmf;

const PRISMA_DIR = resolve(__dirname, '..', '..', 'prisma');
const schemaText = (f: string): string => readFileSync(resolve(PRISMA_DIR, f), 'utf8');

function loadSqliteDmmf(): Dmmf {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require(SQLITE_CLIENT_SPECIFIER) as { Prisma: { dmmf: Dmmf } }).Prisma.dmmf;
  } catch (e) {
    throw new Error(
      `The SQLite client is not generated, so engine parity cannot be checked. ` +
      `Run \`npm run db:generate\`. (${(e as Error).message.split('\n')[0]})`,
      { cause: e },
    );
  }
}

/**
 * `Model.field:Type` — name, kind and type, which is what a v7 DMMF still reports.
 *
 * Nullability and list-ness used to be here too. They are checked against the schemas below rather
 * than dropped: rendering `?` for every field on both engines would have made this look complete
 * while comparing a constant.
 */
const signature = (d: Dmmf): string[] =>
  d.datamodel.models
    .flatMap((m) => m.fields.map((f) => `${m.name}.${f.name}:${f.kind}:${f.type}`))
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

  it('has the same fields, kinds and types on every model', () => {
    expect(signature(sq)).toEqual(signature(pg));
  });

  it('the DMMF still carries what these comparisons read', () => {
    // The guard that makes a future removal loud. When Prisma 7 dropped isRequired, isId, isUnique,
    // hasDefaultValue and relationOnDelete, five assertions in this file kept passing while
    // comparing nothing — because both engines lost them together. Anything this file reads is
    // asserted present here, so the next removal fails one obvious test instead of quietly
    // hollowing out the suite.
    const field = pg.datamodel.models[0].fields[0] as unknown as Record<string, unknown>;
    for (const property of ['name', 'kind', 'type']) {
      expect(field, `DMMF field lost "${property}" — the comparisons here now check less than they claim`)
        .toHaveProperty(property);
    }
    const relation = pg.datamodel.models
      .flatMap((m) => m.fields).find((f) => f.kind === 'object') as unknown as Record<string, unknown>;
    expect(relation).toHaveProperty('relationName');
  });

  it('has the same nullability and defaultability on every column', () => {
    // A field that is required on one engine and optional on the other is the quiet kind of drift:
    // both schemas stay valid, and a write that succeeds in server mode fails in standalone.
    //
    // Read from the two schema files because the v7 DMMF no longer reports either fact. The reader
    // is the one that produces the backup fingerprint, so a disagreement here is the same
    // disagreement that would make a cross-engine restore refuse.
    expect(parseColumnFacts(schemaText('schema.sqlite.prisma')))
      .toEqual(parseColumnFacts(schemaText('schema.prisma')));
  });

  it('has the same primary key on every model', () => {
    expect(parseModelKeys(schemaText('schema.sqlite.prisma')))
      .toEqual(parseModelKeys(schemaText('schema.prisma')));
  });

  it('really compared two different schemas, not one file twice', () => {
    // Both assertions above would pass vacuously if the two paths resolved to the same text — which
    // is exactly the shape of failure this file exists to catch.
    expect(schemaText('schema.sqlite.prisma')).not.toBe(schemaText('schema.prisma'));
    expect(Object.keys(parseColumnFacts(schemaText('schema.prisma'))).length).toBeGreaterThan(10);
    expect(Object.keys(parseModelKeys(schemaText('schema.sqlite.prisma'))).length).toBeGreaterThan(10);
  });

  it('has the same relations', () => {
    // `relationName` survives in a v7 DMMF; `relationOnDelete` does not. The cascade rules it used
    // to compare are covered by the whole-file assertion below — they are `@relation(… onDelete:)`
    // text, and that text is identical in both schemas or the derivation test fails.
    const rels = (d: Dmmf) =>
      d.datamodel.models
        .flatMap((m) => m.fields.filter((f) => f.relationName)
          .map((f) => `${m.name}.${f.name} -> ${f.type} (${f.relationName})`))
        .sort();
    expect(rels(sq)).toEqual(rels(pg));
  });

  it('has the same cascade rules and default VALUES, by deriving one schema from the other', () => {
    // What the DMMF can no longer answer, the derivation answers more strongly.
    //
    // Cascade rules are enforcement, not decoration: NexusKey cascades from Team specifically so
    // deleting a team destroys its BYOK credentials rather than releasing them into the shared pool.
    // A default that exists on one engine and not the other turns an omitted column into a null on
    // exactly one of them — e.g. TokenUsage.outcome, which every analytics aggregate filters on.
    //
    // Both are `@relation(…)` and `@default(…)` text. The SQLite schema is generated from the
    // Postgres one by a two-substitution transform, so if every line except the datasource provider
    // and the generator output is character-identical, every cascade and every default value is
    // identical too — which is a stronger statement than comparing two lists of them.
    const ignorable = (line: string): boolean =>
      /^\s*(provider|output)\s*=/.test(line) || line.startsWith('//') || line.trim() === '';

    const pgLines = schemaText('schema.prisma').split(/\r?\n/).filter((l) => !ignorable(l));
    const sqLines = schemaText('schema.sqlite.prisma').split(/\r?\n/).filter((l) => !ignorable(l));

    expect(sqLines).toEqual(pgLines);
    // Guards the filter: if `ignorable` ever matched everything, the comparison above would pass on
    // two empty arrays.
    expect(pgLines.length).toBeGreaterThan(100);
    expect(pgLines.join('\n')).toContain('onDelete: Cascade');
    expect(pgLines.join('\n')).toContain('@default(');
  });
});
