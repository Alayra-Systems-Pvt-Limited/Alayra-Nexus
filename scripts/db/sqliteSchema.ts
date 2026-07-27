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

// Derives the SQLite schema from the PostgreSQL one (Phase S2).
//
// Prisma cannot take `provider` from an env var — `provider = env("DATABASE_URL")` is a hard
// validation error (P1012) — so supporting two engines means two schema files and two generated
// clients. The obvious way to get the second file is to copy it once and maintain both, and that
// is precisely the failure this script exists to prevent: the day someone adds a column to one and
// not the other, standalone mode breaks in a way no test would catch, because both files would
// still be internally valid. Deriving it makes drift impossible by construction.
//
// The derivation is deliberately TWO substitutions and nothing else. Every model, field, index and
// comment is carried across untouched — verified in S2's audit, where the whole schema pushed to
// SQLite with only the datasource changed. If a future model ever does need engine-specific
// treatment, it belongs here as an explicit, named rule rather than a silent hand-edit downstream.
//
//   npm run db:sqlite-schema           write prisma/schema.sqlite.prisma
//   npm run db:sqlite-schema -- --check exit 1 if it is out of date (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT   = resolve(__dirname, '..', '..');
const SOURCE = resolve(ROOT, 'prisma', 'schema.prisma');
const TARGET = resolve(ROOT, 'prisma', 'schema.sqlite.prisma');
/** The DDL a standalone gateway runs against an empty database file. See src/lib/sqliteBootstrap.ts. */
const DDL    = resolve(ROOT, 'prisma', 'sqlite-schema.sql');

/** Where the second client is generated. Inside node_modules/.prisma so that it resolves as a bare
 *  specifier from both `src/` (tsx) and `dist/` (compiled) without a path that escapes rootDir —
 *  the same place, and for the same reason, that Prisma puts the default client. */
export const SQLITE_CLIENT_OUTPUT = '../node_modules/.prisma/client-sqlite';

const BANNER = `// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.
//
// Derived from prisma/schema.prisma by scripts/db/sqliteSchema.ts. Edit that schema and re-run
// \`npm run db:sqlite-schema\`; a hand-edit here is erased by the next run and, worse, would go
// unnoticed until standalone mode disagreed with server mode about what a row looks like.
// ─────────────────────────────────────────────────────────────────────────────
`;

/** The whole engine difference, as a pure string transform so it can be tested without a filesystem. */
export function toSqliteSchema(postgresSchema: string): string {
  let out = postgresSchema;

  // 1. The datasource. Anchored to the provider line inside the datasource block rather than a
  //    bare global replace: "postgresql" also appears in prose comments, and rewriting those would
  //    produce a file that is correct but lies about itself.
  const dsBefore = out;
  out = out.replace(
    /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"postgresql"/,
    '$1"sqlite"',
  );
  if (out === dsBefore) {
    throw new Error('Could not find `provider = "postgresql"` in the datasource block of prisma/schema.prisma.');
  }

  // 2. The generator output, so the two clients land in different directories instead of the second
  //    silently overwriting the first — which would leave the Postgres deployment running a SQLite
  //    client and failing at the first query.
  const genBefore = out;
  out = out.replace(
    /(generator\s+client\s*\{\s*\n)/,
    `$1  output   = "${SQLITE_CLIENT_OUTPUT}"\n`,
  );
  if (out === genBefore) {
    throw new Error('Could not find a `generator client { … }` block in prisma/schema.prisma.');
  }

  return BANNER + out;
}

const DDL_BANNER =
`-- GENERATED FILE — DO NOT EDIT.
--
-- The schema a standalone gateway creates on first run, emitted by \`prisma migrate diff\` from
-- prisma/schema.sqlite.prisma and executed by src/lib/sqliteBootstrap.ts.
--
-- It is committed rather than produced at runtime because a gateway started with \`npx\` has no
-- Prisma CLI to hand and no network to fetch one — and the first thing it must do is create its own
-- database. Regenerate with \`npm run db:sqlite-schema\`; a drift test fails if this falls behind.

`;

/** The whole DDL, from Prisma rather than hand-written, so it cannot disagree with the schema. */
function generateDdl(): string {
  const sql = execFileSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', TARGET, '--script'],
    { cwd: ROOT, encoding: 'utf8', shell: true },
  );
  if (!/CREATE TABLE/i.test(sql)) {
    // An empty or error-shaped result would otherwise be committed as a "schema" that creates
    // nothing, and the failure would surface as "no such table" on someone's first run.
    throw new Error(`prisma migrate diff produced no CREATE TABLE statements:\n${sql.slice(0, 400)}`);
  }
  return DDL_BANNER + sql.replace(/\r\n/g, '\n');
}

function main(): void {
  const check    = process.argv.includes('--check');
  const expected = toSqliteSchema(readFileSync(SOURCE, 'utf8'));

  if (check) {
    let actual = '';
    try { actual = readFileSync(TARGET, 'utf8'); } catch { /* missing counts as out of date */ }
    if (actual !== expected) {
      console.error('prisma/schema.sqlite.prisma is out of date with prisma/schema.prisma.');
      console.error('Run `npm run db:sqlite-schema` and commit the result.');
      process.exit(1);
    }

    // And the DDL, which is the one a running gateway executes. A stale schema file is caught by a
    // unit test; a stale DDL is not, because nothing can tell it is stale without regenerating it —
    // and its failure mode is a first-time user whose brand-new database is missing a column.
    let actualDdl = '';
    try { actualDdl = readFileSync(DDL, 'utf8'); } catch { /* missing counts as out of date */ }
    if (actualDdl !== generateDdl()) {
      console.error('prisma/sqlite-schema.sql is out of date with prisma/schema.prisma.');
      console.error('Run `npm run db:sqlite-schema` and commit the result.');
      process.exit(1);
    }

    console.log('prisma/schema.sqlite.prisma and prisma/sqlite-schema.sql are both up to date.');
    return;
  }

  writeFileSync(TARGET, expected);
  console.log(`Wrote ${TARGET}`);

  // Second, because migrate diff reads the file just written.
  writeFileSync(DDL, generateDdl());
  console.log(`Wrote ${DDL}`);
}

if (require.main === module) main();
