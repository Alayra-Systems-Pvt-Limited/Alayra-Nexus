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

// Startup diagnostics. Pure string formatting only — the checks that actually open
// connections live in services/preflight.service.ts.
//
// The gateway hard-depends on Postgres and Redis. When either is missing the driver
// reports it as a retry storm followed by an opaque error, which tells an operator
// nothing about what to start. These helpers turn that into an instruction.

export type Dependency = 'redis' | 'database';

/**
 * Reduce a connection URL to `host:port` for display.
 *
 * Connection URLs routinely carry a password (`redis://:secret@host:6379`,
 * `postgresql://user:secret@host/db`). A startup error is printed to stdout and
 * scraped into log aggregators, so the credential must never survive this function.
 * Anything unparseable degrades to a constant rather than echoing the raw string.
 */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return '(not set)';
  try {
    const u = new URL(raw);
    // A SQLite URL has no host, so the host:port reduction below rendered it as an empty string —
    // a failure message that named no database at all. There is nothing to redact in a local path
    // (no credentials can appear in one), and the path is the single most useful thing to print
    // when the error is "unable to open the database file".
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname) || raw;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '(unparseable URL)';
  }
}

const HELP: Record<Dependency, { label: string; envVar: string; hint: string[] }> = {
  redis: {
    label:  'Redis',
    envVar: 'REDIS_URL',
    hint: [
      'Start it with Docker:',
      '    docker compose up -d redis',
      '',
      'Redis is required — it holds rate-limit counters, circuit-breaker state,',
      'sticky routing, team budgets, and the response cache.',
    ],
  },
  database: {
    label:  'PostgreSQL',
    envVar: 'DATABASE_URL',
    hint: [
      'Start it with Docker, then apply migrations:',
      '    docker compose up -d postgres',
      '    npm run migrate',
      '',
      'Postgres stores provider pools, keys, the model registry, teams, and usage.',
    ],
  },
};

/**
 * The database entry above describes PostgreSQL, because for most of this project's life that was
 * the only database there was. On SQLite every line of it is wrong: the engine is not PostgreSQL,
 * the setting is not DATABASE_URL (standalone leaves it unset on purpose), and `docker compose up
 * -d postgres` plus a migration is advice that cannot help — SQLite has no server to start and the
 * gateway creates its own schema.
 *
 * A container hitting this printed "Cannot reach PostgreSQL at" with an empty address, and told the
 * operator to start Postgres, when the real problem was a data directory it could not write to.
 * Being unable to say what is wrong is bad; confidently naming the wrong thing is worse.
 */
function engineAware(dep: Dependency, url: string | undefined): { label: string; envVar: string; hint: string[] } {
  if (dep !== 'database' || !url?.startsWith('file:')) return HELP[dep];
  return {
    label:  'SQLite',
    envVar: 'database file',
    hint: [
      'Standalone mode keeps its database in a local file, so nothing needs starting —',
      'but the directory holding it has to be writable by this process.',
      '',
      'In Docker this is nearly always a bind mount. Docker creates the host directory as',
      'root while the gateway runs unprivileged, so it cannot write there. A named volume',
      'is seeded from the image and inherits its ownership, so it just works:',
      '',
      '    -v nexus-data:/app/.nexus',
      '',
      'To keep the data somewhere you can see it, own that directory and run as yourself:',
      '',
      '    docker run --user "$(id -u):$(id -g)" -v "$PWD/nexus-data:/app/.nexus" …',
      '',
      'Or point the gateway somewhere it can write with NEXUS_DATA_DIR.',
    ],
  };
}

/**
 * A single, actionable startup failure message. Deliberately not an exception dump:
 * the stack of an ECONNREFUSED tells an operator nothing they can act on.
 */
export function formatStartupFailure(dep: Dependency, url: string | undefined, err: unknown): string {
  const { label, envVar, hint } = engineAware(dep, url);
  const reason = err instanceof Error ? err.message : String(err);
  return [
    '',
    `✗  Cannot reach ${label} at ${redactUrl(url)}`,
    '',
    `   ${envVar}=${redactUrl(url)}`,
    `   ${reason}`,
    '',
    ...hint.map((l) => (l ? `   ${l}` : '')),
    '',
    '   To preview the dashboard without any services, run its dev server on its own:',
    '       npm --prefix web run dev',
    '',
  ].join('\n');
}
