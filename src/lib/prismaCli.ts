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

// Running Prisma's own CLI against a database that is not ours yet (Phase S3).
//
// ── Why this is possible at all, and why a comment elsewhere says it is not ───────────────────
//
// `sqliteBootstrap.ts` states the Prisma CLI is "a dev dependency, absent from a published
// package". That was true when it was written and is not true now: `prisma` sits in
// `dependencies`, the `prisma/` directory ships in `files` (migrations included), and
// `scripts/npm/postinstall.js` already resolves and spawns this exact binary on every install to
// generate the two clients. That comment has been corrected where it lives.
//
// ── Why `migrate deploy` and not the committed DDL ────────────────────────────────────────────
//
// Standalone creates its schema by executing `prisma/sqlite-schema.sql` directly, because a
// first-run SQLite file needs a schema once and will never be upgraded in place. A Postgres a
// customer is moving TO is the opposite: it is the database they will keep, and upgrade, for
// years. Raw DDL would leave it with the right tables and an EMPTY `_prisma_migrations` table, so
// their next upgrade would replay migration 0001 against tables that already exist and fail with
// "table already exists" — at which point they have a broken production database and no obvious
// way back. `migrate deploy` records the history, which is the whole difference between a schema
// and a maintainable one.
//
// ── Why the URL never appears in an argument ──────────────────────────────────────────────────
//
// A connection string carries a password, and process arguments are readable by any other process
// on the machine (`ps`, /proc, Task Manager). The environment of a child is not exposed the same
// way, so the URL is passed there. It is also scrubbed from anything this module returns, because
// Prisma prints the host — and sometimes more — on failure, and that output ends up in an audit
// record and on an operator's screen.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Where the Postgres schema lives, relative to this module.
 *
 * `../../prisma` resolves from both `src/lib` (tsx) and `dist/lib` (compiled), because `dist` sits
 * at the same depth as `src` — the same reasoning as `sqliteBootstrap`'s DDL path.
 */
const SCHEMA_PATH = resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

/** Long enough for a cold managed Postgres to accept a first connection and replay every migration. */
export const MIGRATE_TIMEOUT_MS = 5 * 60_000;

export class PrismaCliMissingError extends Error {
  constructor() {
    super(
      'The Prisma command-line tool is not installed alongside this gateway, so the database schema '
      + 'cannot be created. This usually means the install skipped its lifecycle scripts — reinstall '
      + 'without `--ignore-scripts`.',
    );
    this.name = 'PrismaCliMissingError';
  }
}

/**
 * Prisma's own entry point, not `npx prisma`.
 *
 * `npx` may reach the network or resolve a different version; this is the CLI installed beside us,
 * which is the one the generated client was built for. Same resolution the install script uses.
 */
export function resolvePrismaCli(): string {
  try {
    return require.resolve('prisma/build/index.js');
  } catch {
    throw new PrismaCliMissingError();
  }
}

/**
 * Remove anything that could carry a credential from text on its way to a human.
 *
 * Prisma echoes the datasource on several failure paths. Rather than trying to predict which, every
 * URL-shaped run is replaced wholesale — a redaction that is too eager costs a little diagnostic
 * detail, one that is too narrow leaks a production password into an audit record that is designed
 * to be kept.
 */
export function scrubUrls(text: string): string {
  return text.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`]+/g, '<connection string hidden>');
}

export interface MigrateResult {
  ok: boolean;
  /** Prisma's own output, scrubbed. Shown to the operator when something went wrong. */
  output: string;
}

/**
 * Create or update the Nexus schema in `databaseUrl`.
 *
 * Never throws for a database-side failure — those are answers, not exceptions, and the caller
 * turns them into something an operator can act on. Throws only when the CLI itself is unavailable,
 * which is a broken installation rather than a bad address.
 */
export async function migrateDeploy(
  databaseUrl: string,
  timeoutMs: number = MIGRATE_TIMEOUT_MS,
): Promise<MigrateResult> {
  const cli = resolvePrismaCli();

  return new Promise<MigrateResult>((done) => {
    const child = spawn(
      process.execPath,
      [cli, 'migrate', 'deploy', '--schema', SCHEMA_PATH],
      {
        // The URL goes here and NOT in argv — see the note at the top of this file.
        //
        // Prisma reads its datasource from DATABASE_URL, and this gateway may itself be running on
        // SQLite with that variable unset or pointing at a file. Passing the parent environment
        // through with one key replaced keeps PATH and the platform's own variables intact while
        // making certain the child cannot inherit a stale one.
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let output = '';
    const collect = (chunk: Buffer): void => {
      // Bounded: a runaway child must not be able to grow this without limit, and nothing useful to
      // an operator lives past the first few KB of a migration log.
      if (output.length < 16_384) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill();
      settle(false, `${output}\nTimed out after ${Math.round(timeoutMs / 1000)}s.`);
    }, timeoutMs);
    // Never hold the process open on account of a migration that is already being awaited.
    if (typeof timer.unref === 'function') timer.unref();

    let settled = false;
    const settle = (ok: boolean, text: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok, output: scrubUrls(text).trim() });
    };

    // 'error' fires when the child could not be spawned at all; without this the promise would
    // never settle and the request would hang until the client gave up.
    child.on('error', (err) => settle(false, `${output}\n${(err as Error).message}`));
    child.on('close', (code) => settle(code === 0, output));
  });
}
