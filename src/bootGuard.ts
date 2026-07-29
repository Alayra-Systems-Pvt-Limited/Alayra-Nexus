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

// The storage configuration check, and the reason it is its own module.
//
// `lib/redis.ts` throws the moment it is imported when REDIS_URL is unset, and imports are evaluated
// before any statement in the importing module. So a check placed inside bootstrap() — or even at the
// top of server.ts — would run *after* that throw, and the operator would get
// "FATAL: REDIS_URL is not set" instead of the message explaining which two settings disagree.
//
// Importing this module FIRST in server.ts fixes the ordering: CommonJS evaluates `require` calls in
// source order, so this runs before the graph that reaches lib/redis.ts. That is the whole purpose of
// the file, and it is why the import must stay in first position.
//
// It deliberately holds no logic. Resolution lives in lib/mode.ts, which is pure and exhaustively
// tested; this only prints and exits, so there is nothing here worth a unit test.

import { resolveMode, describeMode, ephemeralWarning, pinStorageEnv, type ResolvedMode } from './lib/mode';

// Before anything else, and before `check()` below reads the environment.
//
// Importing `@prisma/client` loads the `.env` beside its schema, so a variable this gateway was
// deliberately started WITHOUT can be set behind its back, three levels down an import chain, after
// the check below has already passed and printed. Changing directory is no escape — the file is
// found from the schema, not from the working directory. Pinning declares the absence explicitly,
// and an explicit value is one no env-file loader will overwrite. `pinStorageEnv` documents the
// full sequence.
//
// It belongs here rather than in `lib/prisma.ts` for the same reason this module exists at all:
// `@prisma/client` is reached through several modules — `lib/dialect.ts` and
// `services/analytics.service.ts` among them — so guarding one of them guards nothing. There is
// exactly one place that is reliably earlier than all of them, and this is it.
pinStorageEnv();

function die(lines: string[]): never {
  console.error(`\n✖  ${lines[0]}`);
  for (const l of lines.slice(1)) console.error(`   ${l}`);
  console.error('');
  process.exit(1);
}

function check(): ResolvedMode {
  const m = resolveMode();

  // A contradiction or a malformed value. Every message names the settings involved and what to do.
  if (m.errors.length > 0) {
    die([
      m.errors.length === 1 ? 'Storage configuration problem:' : 'Storage configuration problems:',
      ...m.errors,
    ]);
  }

  // Kept as a backstop, not as live behaviour (S2.4). Every combination `resolveMode` can return is
  // now buildable, so this branch is unreachable today — and it stays because the next engine added
  // to those unions will make it reachable again, and the alternative to an honest refusal is a
  // gateway that boots half-configured.
  if (!m.isImplemented) {
    die([
      `This build cannot run on ${describeMode(m)}.`,
      '',
      ...m.reasons,
      '',
      'Supported: PostgreSQL or SQLite for the durable store, Redis or in-process memory for',
      'counters and sessions. Unset both URLs for a zero-configuration standalone gateway, or set:',
      '',
      '  DATABASE_URL=postgresql://user:password@host:5432/dbname',
      '  REDIS_URL=redis://host:6379',
      '',
      'The three-line Docker Compose quick start in the README brings both up for you.',
    ]);
  }

  return m;
}

/** The resolved storage configuration, checked. Safe to read anywhere after server.ts has loaded. */
export const MODE: ResolvedMode = check();

/** Printed once the server is listening, so the operator sees what they are running on. */
export function logMode(): void {
  console.log(`    Storage → ${describeMode(MODE)}`);
  const warning = ephemeralWarning(MODE);
  if (warning) console.log(`\n⚠  ${warning}`);
}
