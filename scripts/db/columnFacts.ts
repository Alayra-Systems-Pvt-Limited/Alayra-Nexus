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

// Two facts per column, read from the schema rather than from Prisma.
//
// ── Why this file has to exist ────────────────────────────────────────────────────────────────
//
// The backup schema fingerprint (lib/backup/provenance.ts) describes every column four ways:
// name, type, required-or-not, and whether the database can produce a value for it. The last two
// are what let a restore distinguish "this backup predates a nullable column" — fine, restore it —
// from "this backup predates a REQUIRED column with no default" — which cannot be honoured and must
// be refused before anything is emptied.
//
// All four used to come from Prisma's DMMF. Prisma 7 reduces the DMMF field to `{name, kind, type}`:
// `isRequired`, `hasDefaultValue` and `isUpdatedAt` are gone. Read through the old code on v7, every
// column reports itself optional and defaultless, and the failure is not that the check goes quiet —
// it is that `missing-required` (blocking, "this backup cannot be restored") degrades into
// `missing-fillable`, whose message is "it will take its default". A restore that cannot succeed
// would be described to the operator as safe. False reassurance is worse than no check.
//
// Prisma was never the SOURCE of those two facts, only a convenient relay. `prisma/schema.prisma` is
// the source, and it still says everything needed:
//
//     baseUrl    String?                        → optional
//     authHeader String  @default("Authorization") → required, defaultable
//
// So this reads them from there, at build time, into a committed module. Build time rather than
// runtime because a gateway started with `npx` has its `dist/` and nothing else — no schema file to
// parse and no guarantee of a readable path — and because a committed artifact can be checked in CI.
//
// ── Why a .ts module and not .json ────────────────────────────────────────────────────────────
//
// It compiles into `dist/` with everything else, so it needs no copy step in the build, no entry in
// `files`, and no path resolution at runtime that could differ between `tsx src/`, `node dist/` and
// npx. A JSON file would have needed all three, and each is a way for this to be missing in exactly
// the deployment that is hardest to debug.
//
//   npm run db:column-facts            write src/lib/backup/columnFacts.generated.ts
//   npm run db:column-facts -- --check exit 1 if it is out of date (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ColumnFacts } from '../../src/lib/backup/columnFactsTypes';

const ROOT   = resolve(__dirname, '..', '..');
const SOURCE = resolve(ROOT, 'prisma', 'schema.prisma');
const TARGET = resolve(ROOT, 'src', 'lib', 'backup', 'columnFacts.generated.ts');

/**
 * The scalar types Prisma reports as `kind: 'scalar'`.
 *
 * Enums are deliberately absent: the DMMF calls them `kind: 'enum'`, and provenance.ts fingerprints
 * scalars only. If this list and that filter ever disagree, the fingerprint gains or loses a column
 * with no schema change behind it — so `columnFacts.test.ts` asserts the two agree field for field
 * rather than trusting this list to stay right.
 */
const SCALAR_TYPES = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes',
]);

/**
 * Strip `//` comments without touching one inside a string literal.
 *
 * A naive `split('//')` is fine against today's schema and wrong the first time somebody writes
 * `@default("https://…")` — at which point the column silently loses its default in the fingerprint
 * and a blocking check turns into a reassuring one. That is precisely the failure this file exists
 * to remove, so it is not reintroduced here to save four lines.
 */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/**
 * Every line's comment removed, before anything else looks at the text.
 *
 * Order matters: a comment can contain a brace (`// see model Foo { }`), so stripping has to happen
 * before the brace splitting below or a stray `}` in prose would end a model early and drop the rest
 * of its columns.
 */
const stripComments = (schema: string): string =>
  schema.split(/\r?\n/).map(stripComment).join('\n');

/**
 * Break a schema into one logical line per newline AND per brace.
 *
 * `model A { id String @id }` is valid and parses to nothing under a purely line-based reader —
 * every column of that model silently gets no facts. It fails loudly downstream (schemaShape throws
 * rather than guessing), so it is a footgun rather than a hole, but a parser whose answer depends on
 * where somebody pressed Enter is not one to keep.
 *
 * Braces inside a string literal are left alone: `@default("{}")` is a legal Json default, and
 * splitting on it would cut a field line in half.
 */
function logicalLines(schema: string): string[] {
  const out: string[] = [];
  for (const raw of schema.split(/\r?\n/)) {
    let buf = '';
    let quoted = false;
    for (const c of raw) {
      if (c === '"') quoted = !quoted;
      if (!quoted && (c === '{' || c === '}')) {
        out.push(`${buf}${c === '{' ? '{' : ''}`);
        if (c === '}') out.push('}');
        buf = '';
        continue;
      }
      buf += c;
    }
    out.push(buf);
  }
  return out;
}

/**
 * Read the two facts for every scalar column, from the text of a Prisma schema.
 *
 * Pure, so the tests can feed it a schema fragment and assert on the result without a filesystem.
 */
export function parseColumnFacts(schema: string): ColumnFacts {
  const out: ColumnFacts = {};
  let model: string | null = null;

  for (const raw of logicalLines(stripComments(schema))) {
    const line = raw.trim();
    if (line === '') continue;

    if (model === null) {
      const head = /^model\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
      if (head) { model = head[1]; out[model] = {}; }
      continue;
    }

    if (line.startsWith('}')) { model = null; continue; }
    if (line.startsWith('@@')) continue; // block attribute: @@index, @@unique, @@map

    const field = /^([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?(.*)$/.exec(line);
    if (!field) continue;

    const [, name, type, list, optional, rest] = field;
    if (!SCALAR_TYPES.has(type)) continue; // a relation or an enum; not part of the fingerprint

    // A list is `isRequired: true` in the DMMF — `String[]` defaults to empty rather than null, so
    // there is no "absent" state for it to be in. Matched here so the two agree.
    const required    = optional !== '?';
    const defaultable = /@default\s*\(/.test(rest) || /@updatedAt\b/.test(rest);

    void list;
    out[model][name] = `${required ? 'req' : 'opt'}:${defaultable ? 'def' : 'nodef'}`;
  }

  return out;
}

const BANNER = `/*
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

// GENERATED FILE — DO NOT EDIT.
//
// Derived from prisma/schema.prisma by scripts/db/columnFacts.ts. Edit that schema and re-run
// \`npm run db:column-facts\`; CI fails if this falls behind, because a stale entry here makes the
// backup drift check describe a restore that cannot succeed as one that can.
//
// Why these two facts are not read from Prisma: scripts/db/columnFacts.ts explains it in full.

import type { ColumnFacts } from './columnFactsTypes';

export const COLUMN_FACTS: ColumnFacts = `;

/** The artifact, as source text. LF throughout — see the note in main(). */
export function renderModule(facts: ColumnFacts): string {
  const models = Object.keys(facts).sort();
  const body = models.map((model) => {
    const columns = Object.keys(facts[model]).sort();
    const entries = columns.map((c) => `    ${c}: '${facts[model][c]}',`).join('\n');
    return `  ${model}: {\n${entries}\n  },`;
  }).join('\n');

  return `${BANNER}{\n${body}\n};\n`;
}

/**
 * Line endings are normalised before comparing.
 *
 * Not defensive padding: `scripts/db/sqliteSchema.ts` compares raw text and is consequently red on
 * every Windows checkout, because TypeScript normalises template-literal newlines to LF while git
 * hands the schema over as CRLF. The generated text and the file on disk can legitimately differ in
 * line endings alone, and a check that fails on that teaches its author to ignore it.
 */
const normalize = (s: string): string => s.replace(/\r\n/g, '\n');

function main(): void {
  const check    = process.argv.includes('--check');
  const expected = renderModule(parseColumnFacts(readFileSync(SOURCE, 'utf8')));

  if (check) {
    let actual = '';
    try { actual = readFileSync(TARGET, 'utf8'); } catch { /* missing counts as out of date */ }
    if (normalize(actual) !== normalize(expected)) {
      console.error('src/lib/backup/columnFacts.generated.ts is out of date with prisma/schema.prisma.');
      console.error('Run `npm run db:column-facts` and commit the result.');
      process.exit(1);
    }
    console.log('src/lib/backup/columnFacts.generated.ts is up to date.');
    return;
  }

  writeFileSync(TARGET, expected);
  console.log(`Wrote ${TARGET}`);
}

if (require.main === module) main();
