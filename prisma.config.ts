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
// CI and `postinstall` generate a client long before any database exists.
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

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  datasource: {
    // Absent during `generate`, which does not need it. The CLI raises a clear error naming this
    // file if a command that DOES need it is run without one.
    url: env('DATABASE_URL'),
  },
});
