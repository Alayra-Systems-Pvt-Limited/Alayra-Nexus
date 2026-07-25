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
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveMode, resolveDatabaseUrl } from './mode';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const log: ('query' | 'error' | 'warn')[] =
  process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'];

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
  return new mod.PrismaClient({ log, datasources: { db: { url } } }) as PrismaClient;
}

function construct(): PrismaClient {
  return resolveMode().db === 'sqlite' ? constructSqlite() : new PrismaClient({ log });
}

export const prisma = globalForPrisma.prisma || construct();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
