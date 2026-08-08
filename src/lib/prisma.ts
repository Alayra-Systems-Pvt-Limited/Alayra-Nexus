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

// The database client — one of two, chosen from the environment (Phase S2).
//
// Prisma refuses `provider = env(…)`, so two engines means two generated clients. This module is
// the single place that knows there are two: every importer keeps asking for `prisma` and keeps
// getting the same interface, exactly as it did when there was only Postgres.
//
// The Postgres branch below is UNCHANGED from before standalone mode existed — same constructor,
// same options, no datasource override, so it still reads DATABASE_URL the way it always has. That
// is on purpose. A gateway running on a real Postgres must not be able to notice this phase
// happened; the only new code on its path is one `if` that evaluates false.
//
// The exported type is the POSTGRES client, and the SQLite instance is cast to it. The two are
// nearly identical but not exactly: SQLite has no `createMany({ skipDuplicates })`, which is not
// merely absent at runtime but absent from the generated type. Every such difference has to be
// handled explicitly at its call site — the cast is a claim that they have been, not a licence to
// ignore them. `prisma.delegates.test.ts` checks that the two clients still agree on every model
// and method this codebase calls. That check is necessary but, as S1 learned when an in-memory KV
// satisfied every type check and then crashed a real boot, it is not sufficient: booting a SQLite
// gateway end to end is what actually proves this, and that is S2.4.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveMode, resolveDatabaseUrl, type DbEngine } from './mode';
import { SQLITE_TIMESTAMP_FORMAT, type SqliteAdapterOptions } from './sqliteTimestamp';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// PRISMA_LOG_QUERIES is a diagnostic switch, separate from NODE_ENV on purpose: the question
// "how many queries does one request make" can only be answered against a PRODUCTION build, since
// that is the build whose cost we care about, and NODE_ENV=development changes more than logging.
// Off unless asked for — query logging is expensive enough to distort what it is measuring.
const log: ('query' | 'error' | 'warn')[] =
  process.env.NODE_ENV === 'development' || process.env.PRISMA_LOG_QUERIES === '1'
    ? ['query', 'error', 'warn']
    : ['error'];

/** The bare specifier the second client is generated under. See scripts/db/sqliteSchema.ts. */
export const SQLITE_CLIENT_SPECIFIER = '.prisma/client-sqlite';

function constructSqlite(): PrismaClient {
  const url = resolveDatabaseUrl();

  // Prisma creates the database file but not the directory holding it, and the default lives in a
  // `.nexus/` folder that has never existed on a first run — so without this the very first query
  // fails with a bare "unable to open database file".
  if (url.startsWith('file:')) {
    try {
      mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
    } catch {
      // Left to Prisma to report: it names the path and the reason, and a failure to pre-create is
      // not itself proof the database is unusable (the directory may already exist).
    }
  }

  // Required rather than imported: this specifier only resolves once `prisma generate` has run
  // against the SQLite schema, and a Postgres deployment must not fail to start because a client it
  // is never going to use was not generated.
  //
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(SQLITE_CLIENT_SPECIFIER) as { PrismaClient: new (opts?: unknown) => unknown };

  // The adapter is required lazily for the SAME reason, and it matters more here than for the
  // client: this one is a native addon. A Postgres deployment must never load it, so that a machine
  // where the binary is missing or built for another ABI still starts and serves — it is not on
  // that gateway's path at all.
  //
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3') as {
    PrismaBetterSqlite3: new (opts: { url: string }, options?: SqliteAdapterOptions) => unknown;
  };

  return new mod.PrismaClient({
    log,
    adapter: new PrismaBetterSqlite3({ url }, { timestampFormat: SQLITE_TIMESTAMP_FORMAT }),
  }) as PrismaClient;
}

function construct(): { client: PrismaClient; engine: DbEngine } {
  const engine = resolveMode().db;
  if (engine === 'sqlite') return { client: constructSqlite(), engine };

  // Prisma 7 removed `url` from the datasource block, so the connection string is no longer picked
  // up implicitly — it has to be handed to an adapter. `resolveDatabaseUrl()` returns DATABASE_URL
  // whenever it is set, which is exactly what this branch read before, so a gateway already running
  // on Postgres cannot tell the difference.
  return {
    client: new PrismaClient({ log, adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }) }),
    engine,
  };
}

const built = construct();

/**
 * Which engine the client above ACTUALLY is.
 *
 * Produced by the same call that built the client, rather than by asking resolveMode() a second
 * time wherever a dialect is needed. The two would almost always agree, and the once they did not —
 * an env var mutated after import, a test that swapped a client — SQL would be written for one
 * engine and executed on the other, which is the failure mode with no error message. Deriving both
 * from one decision makes disagreement unrepresentable.
 */
export const dbEngine: DbEngine = built.engine;

export const prisma = globalForPrisma.prisma || built.client;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
