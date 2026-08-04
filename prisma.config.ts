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

// Where the Prisma CLI gets a connection string (Prisma 7).
//
// Prisma 7 removed `url` from the datasource block, so `migrate`, `db push` and `db execute` have
// nowhere to read it from unless it is here. `generate` does not need it — which matters, because
// CI, the Docker build and `postinstall` all generate a client long before any database exists.
//
// ── Why it reads the environment rather than naming a database ────────────────────────────────
//
// This repository has TWO schemas, one per engine, and the CLI is pointed at them with `--schema`.
// A URL written here would be right for one and wrong for the other. Every caller already supplies
// the right one through `DATABASE_URL` — the parity harness sets it per engine, the runner sets it
// per stack, and a deployment has it in the environment anyway — so reading it back is the only
// definition that is correct for both.
//
// `schema` is deliberately not pinned for the same reason: `--schema` has to keep choosing.

// ── Why the datasource is conditional ─────────────────────────────────────────────────────────
//
// `env('DATABASE_URL')` reads better and does not work. It resolves when the config FILE loads, not
// when a command needs a database, so it throws for every Prisma invocation without one:
//
//   Failed to load config file as a TypeScript/JavaScript module.
//   Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
//
// `generate` is exactly that case, and it is the one that matters most here. It runs in the
// Dockerfile's builder stage, where `COPY prisma/` has only just happened and no database exists;
// it runs from `postinstall` on a user's machine at `npx` time; and it runs in CI before any
// service container is up. All three broke, and the Docker build is where it was caught.
//
// Omitting the key entirely when there is nothing to put in it leaves `generate` working and still
// gives `migrate`, `db push` and `db execute` the URL whenever one is set — which is always, for the
// commands that need it.

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL?.trim();

export default defineConfig(url ? { datasource: { url } } : {});
