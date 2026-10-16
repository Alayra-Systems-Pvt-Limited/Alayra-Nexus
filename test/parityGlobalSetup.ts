/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Generate the PostgreSQL schema's DDL once per test run, for the parity suites.
//
// Every parity suite needs an empty PostgreSQL database with the schema in it. Asking Prisma for
// the schema once here, rather than once per suite, is what keeps fifteen suite setups from each
// starting the Prisma CLI (see src/lib/parity/engines.ts for the measurements). Runs before any
// worker starts, so the path set below is in every worker's environment. Does nothing when no
// parity database is configured, which is every ordinary `npm test`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

/**
 * `migrate diff --from-empty --to-schema` never opens a connection, but Prisma 7 prints nothing (and
 * exits 0) unless the config has a datasource URL. Set for this one child only, to an address that
 * cannot be reached, so not even a mistake could make it touch a real database.
 */
const NEVER_CONNECTS = 'postgresql://never:never@127.0.0.1:1/never';

export default function setup(): (() => void) | undefined {
  if (!process.env.PARITY_DATABASE_URL?.trim()) return undefined;
  const sql = execFileSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', join(ROOT, 'prisma', 'schema.prisma'), '--script'],
    { cwd: ROOT, encoding: 'utf8', shell: true, env: { ...process.env, DATABASE_URL: NEVER_CONNECTS } },
  );
  if (!/CREATE TABLE/i.test(sql)) throw new Error(`prisma migrate diff produced no CREATE TABLE statements:\n${sql.slice(0, 400)}`);
  const dir = mkdtempSync(join(tmpdir(), 'nexus-parity-ddl-'));
  const file = join(dir, 'postgres.sql');
  writeFileSync(file, sql);
  process.env.PARITY_POSTGRES_DDL_FILE = file;
  return () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } };
}
