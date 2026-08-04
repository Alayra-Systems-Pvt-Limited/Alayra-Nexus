/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The two facts per column that Prisma 7's DMMF stopped reporting.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { parseColumnFacts, renderModule } from './columnFacts';
import { COLUMN_FACTS } from '../../src/lib/backup/columnFacts.generated';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
const normalize = (s: string): string => s.replace(/\r\n/g, '\n');

describe('reading the two facts from a schema', () => {
  it('reads required and defaultable off a plain field', () => {
    expect(parseColumnFacts(`
      model A {
        id      String   @id @default(uuid())
        name    String
        note    String?
        seenAt  DateTime @updatedAt
        count   Int      @default(0)
        maybe   Int?     @default(3)
      }
    `).A).toEqual({
      id:     'req:def',
      name:   'req:nodef',
      note:   'opt:nodef',
      seenAt: 'req:def',   // @updatedAt is a default in every sense that matters to a restore
      count:  'req:def',
      maybe:  'opt:def',
    });
  });

  it('leaves relations out, since only columns are written', () => {
    const facts = parseColumnFacts(`
      model A {
        id      String @id
        keys    B[]
        ownerId String?
        owner   C?     @relation(fields: [ownerId], references: [id])
      }
    `).A;
    expect(Object.keys(facts).sort()).toEqual(['id', 'ownerId']);
  });

  it('ignores block attributes, which are not columns', () => {
    const facts = parseColumnFacts(`
      model A {
        id String @id
        @@index([id])
        @@unique([id])
      }
    `).A;
    expect(Object.keys(facts)).toEqual(['id']);
  });

  it('does not mistake a comment for a field', () => {
    const facts = parseColumnFacts(`
      model A {
        // this line describes the next one
        id String @id
      }
    `).A;
    expect(Object.keys(facts)).toEqual(['id']);
  });

  it('reads a default whose VALUE contains //', () => {
    // The trap. A naive comment strip splits on the first `//` and throws away `@default(...)`,
    // so this column silently becomes `nodef` — and `missing-required` (blocking) degrades into
    // `missing-fillable`, which tells the operator an impossible restore will be fine. Nothing in
    // today's schema has one; the first `@default("https://…")` anybody writes would have.
    expect(parseColumnFacts(`
      model A {
        endpoint String @default("https://api.example.com/v1")
      }
    `).A).toEqual({ endpoint: 'req:def' });
  });

  it('still strips a real comment that follows a string default', () => {
    expect(parseColumnFacts(`
      model A {
        endpoint String @default("https://x.test") // trailing note
        plain    String // @default(nope) is only a comment here
      }
    `).A).toEqual({ endpoint: 'req:def', plain: 'req:nodef' });
  });

  it('treats a scalar list as required, the way the DMMF does', () => {
    // `String[]` has no absent state — it defaults to empty rather than null — and the DMMF reports
    // isRequired: true. Disagreeing here would report drift on a column nobody changed.
    expect(parseColumnFacts('model A {\n  tags String[]\n}').A).toEqual({ tags: 'req:nodef' });
  });

  it('keeps models apart, including one written on a single line', () => {
    // Same column name, different facts, so a parser that leaked state between models would have to
    // produce a visibly wrong answer rather than a coincidentally right one.
    const facts = parseColumnFacts(`
      model A { id String @id @default(uuid()) }
      model B { id String? }
    `);
    expect(facts.A).toEqual({ id: 'req:def' });
    expect(facts.B).toEqual({ id: 'opt:nodef' });
  });

  it('does not treat @id as a default, because it is not one', () => {
    // `@id` constrains a column; it does not produce a value for it. Conflating the two would mark
    // a required id as fillable and let a restore that cannot supply one look safe.
    expect(parseColumnFacts('model A {\n  id String @id\n}').A).toEqual({ id: 'req:nodef' });
  });

  it('is not confused by a brace inside a comment', () => {
    // A stray `}` in prose would otherwise end the model early and drop every column after it.
    expect(parseColumnFacts(`
      model A {
        id   String @id
        // see the note on model B { } elsewhere
        name String
      }
    `).A).toEqual({ id: 'req:nodef', name: 'req:nodef' });
  });

  it('skips the generator and datasource blocks', () => {
    const facts = parseColumnFacts(`
      generator client { provider = "prisma-client-js" }
      datasource db { provider = "postgresql" url = env("DATABASE_URL") }
      model A { id String @id }
    `);
    expect(Object.keys(facts)).toEqual(['A']);
  });
});

describe('the committed artifact', () => {
  it('is current — run `npm run db:column-facts` if this fails', () => {
    expect(normalize(read('src/lib/backup/columnFacts.generated.ts')))
      .toBe(normalize(renderModule(parseColumnFacts(read('prisma/schema.prisma')))));
  });

  it('says it is generated, so nobody edits it by hand', () => {
    expect(read('src/lib/backup/columnFacts.generated.ts')).toContain('GENERATED FILE — DO NOT EDIT');
  });

  it('sorts models and columns, so a schema reorder is not a diff', () => {
    const models = Object.keys(COLUMN_FACTS);
    expect(models).toEqual([...models].sort());
    for (const columns of Object.values(COLUMN_FACTS)) {
      expect(Object.keys(columns)).toEqual([...Object.keys(columns)].sort());
    }
  });
});

// ── The proof, while Prisma still allows it ──────────────────────────────────────────────────
//
// This is the whole justification for the change: the artifact must say EXACTLY what the DMMF said,
// or the fingerprint moves and every backup ever taken reports drift on restore. On Prisma 6 both
// halves are available and can be compared field for field, which is what this does.
//
// It self-skips rather than fails once the DMMF stops carrying `isRequired`, because on that version
// there is nothing to compare against — and a test that quietly passed by comparing `undefined` to
// `undefined` would be worse than one that says it could not run.

type DmmfField = { name: string; kind: string; isRequired?: boolean; hasDefaultValue?: boolean; isUpdatedAt?: boolean };
type DmmfModel = { name: string; fields: readonly DmmfField[] };

const pgModels = (Prisma.dmmf?.datamodel?.models ?? []) as unknown as readonly DmmfModel[];
const dmmfStillReports = pgModels.some((m) => m.fields.some((f) => typeof f.isRequired === 'boolean'));

function sqliteModels(): readonly DmmfModel[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('.prisma/client-sqlite') as { Prisma: { dmmf: { datamodel: { models: unknown[] } } } };
    return mod.Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[];
  } catch {
    return null; // not generated in this checkout; CI generates both
  }
}

function compare(models: readonly DmmfModel[]): string[] {
  const problems: string[] = [];
  for (const m of models) {
    const facts = COLUMN_FACTS[m.name];
    if (!facts) { problems.push(`model absent from artifact: ${m.name}`); continue; }
    for (const f of m.fields) {
      if (f.kind !== 'scalar') continue;
      const dmmf = `${f.isRequired ? 'req' : 'opt'}:${f.hasDefaultValue || f.isUpdatedAt ? 'def' : 'nodef'}`;
      if (facts[f.name] !== dmmf) problems.push(`${m.name}.${f.name}: dmmf=${dmmf} artifact=${facts[f.name]}`);
    }
    const scalars = new Set(m.fields.filter((f) => f.kind === 'scalar').map((f) => f.name));
    for (const name of Object.keys(facts)) {
      if (!scalars.has(name)) problems.push(`${m.name}.${name}: in artifact, not a DMMF scalar`);
    }
  }
  return problems;
}

describe.skipIf(!dmmfStillReports)('agrees with the DMMF, field for field', () => {
  it('matches the PostgreSQL client on every scalar column', () => {
    expect(compare(pgModels)).toEqual([]);
  });

  it('matches the SQLite client too', () => {
    const models = sqliteModels();
    expect(models === null ? [] : compare(models)).toEqual([]);
  });

  it('actually compared something, rather than passing on an empty list', () => {
    const scalars = pgModels.flatMap((m) => m.fields.filter((f) => f.kind === 'scalar'));
    expect(scalars.length).toBeGreaterThan(100);
  });
});
