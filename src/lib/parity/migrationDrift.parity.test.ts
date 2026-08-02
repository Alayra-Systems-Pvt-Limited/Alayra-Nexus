/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The migrations and schema.prisma must describe the same database.
//
// They are two descriptions of one thing, kept in step by hand, and they drifted: by migration 0018
// there were nineteen differences nobody had put there on purpose. None of them broke anything,
// which is exactly why they survived — the cost is paid later, by whoever runs `prisma migrate dev`
// for a one-line change and receives those nineteen statements folded into their migration. They
// then either ship them unread or unpick them under time pressure, and both of those are how a
// schema change goes wrong.
//
// Migration 0017 is what the un-noticed version costs: a table sat in schema.prisma for months with
// no migration creating it, so every FRESH Postgres install lacked it, and the backup export — the
// first feature to walk every table — died on those installs and only those.
//
// ── Why this cannot be a unit test ────────────────────────────────────────────────────────────
//
// Answering "do these agree" means REPLAYING every migration into a real PostgreSQL and comparing
// the result against the schema. There is no offline form of that question, which is why the drift
// went unmeasured for eighteen migrations: the tool needs a database, and a developer machine
// without one silently skips this file. CI has one.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PARITY_DATABASE_URL, PARITY_TIMEOUT, freshDatabase } from './harness';

const enabled = !!PARITY_DATABASE_URL;
const ROOT = resolve(__dirname, '..', '..', '..');

describe.skipIf(!enabled)('the migrations and the schema agree', { timeout: PARITY_TIMEOUT * 4 }, () => {
  it('replays every migration and finds nothing left to change', () => {
    const shadow = freshDatabase('drift');

    // `--from-migrations` is what makes this meaningful: it applies every file in prisma/migrations
    // in order to the shadow database and compares THAT against the schema. `--from-schema-datamodel`
    // would compare the schema with itself and pass while the migrations said something else
    // entirely — the exact way a drift check stops checking.
    const diff = execFileSync(
      'npx',
      [
        'prisma', 'migrate', 'diff',
        '--from-migrations', resolve(ROOT, 'prisma', 'migrations'),
        '--to-schema-datamodel', resolve(ROOT, 'prisma', 'schema.prisma'),
        '--shadow-database-url', shadow,
        '--script',
      ],
      { cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // Prisma writes "-- This is an empty migration." when there is nothing to do. Anything else is
    // a real statement, and the message names it so the failure is actionable rather than a bare
    // "expected false to be true".
    const statements = diff
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'));

    expect(
      statements,
      'prisma/migrations and prisma/schema.prisma have drifted apart. The statements below are what '
      + '`prisma migrate dev` would silently fold into the NEXT migration anyone writes. Generate a '
      + 'migration that applies them — see prisma/migrations/0019_align_migrations_with_schema for '
      + 'how the last one was done — rather than leaving them for someone else to discover:\n'
      + `${statements.join('\n')}\n`,
    ).toEqual([]);
  });
});
