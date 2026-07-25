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

import { resolveMode, describeMode, ephemeralWarning, type ResolvedMode } from './lib/mode';

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

  // Resolution understands SQLite and in-memory counters; the gateway cannot run on them yet. Saying
  // so plainly beats booting half-configured, and beats the bare "REDIS_URL is not set" this replaces
  // — the operator learns what is supported and exactly which variables to set.
  if (!m.isImplemented) {
    die([
      `Alayra Nexus needs PostgreSQL for its durable store. This environment resolves to ${describeMode(m)}.`,
      '',
      ...m.reasons,
      '',
      'A SQLite database is in development and not available in this build. Redis is now optional —',
      'without REDIS_URL the gateway keeps counters and sessions in memory — but a database is not.',
      'Set:',
      '',
      '  DATABASE_URL=postgresql://user:password@host:5432/dbname',
      '',
      'The three-line Docker Compose quick start in the README brings one up for you.',
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
