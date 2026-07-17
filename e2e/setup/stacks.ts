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

// The two gateway stacks the suite runs against, and why there are two.
//
// A gateway can be CLAIMED exactly once per database — the first-run flow is destructive
// by design. Both the API suite and the browser suite need to prove that flow from its
// unclaimed beginning, so they cannot share a database: whichever ran second would find
// the door already claimed. Each project gets its own stack — own database, own Redis
// logical DB, own port — and owns its state from first boot to teardown.
//
// Everything here is a real deployment knob. No test backdoors: the server under test is
// the compiled dist/server.js a deployment runs, configured only through its environment.

import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Where the local Postgres/Redis from docker-compose listen. CI provides the same. */
const PG_BASE    = process.env.E2E_PG_URL    ?? 'postgresql://nexus:nexus@localhost:5432';
const REDIS_BASE = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';

/** The install secret. In a deployment this lives in .env; here it is the claim ticket under test. */
export const ADMIN_PASSWORD = 'e2e-install-secret-2026';

/** 64 hex chars, as encryption.ts requires. A fixed test value — nothing real is encrypted with it. */
export const MASTER_ENCRYPTION_KEY = 'e2e0'.repeat(16);

export const MOCK_PROVIDER_PORT = 3110;
export const MOCK_PROVIDER_URL  = `http://127.0.0.1:${MOCK_PROVIDER_PORT}`;

export interface Stack {
  name: 'api' | 'ui';
  port: number;
  baseURL: string;
  databaseUrl: string;
  redisUrl: string;
}

export const STACKS: Stack[] = [
  {
    name: 'api',
    port: 3100,
    baseURL: 'http://127.0.0.1:3100',
    databaseUrl: `${PG_BASE}/nexus_e2e_api`,
    redisUrl: `${REDIS_BASE}/1`,
  },
  {
    name: 'ui',
    port: 3101,
    baseURL: 'http://127.0.0.1:3101',
    databaseUrl: `${PG_BASE}/nexus_e2e_ui`,
    redisUrl: `${REDIS_BASE}/2`,
  },
];

export function stack(name: 'api' | 'ui'): Stack {
  const s = STACKS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown stack: ${name}`);
  return s;
}

/** The environment a stack's gateway boots with — the whole contract between suite and server. */
export function gatewayEnv(s: Stack): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL:          s.databaseUrl,
    REDIS_URL:             s.redisUrl,
    MASTER_ENCRYPTION_KEY,
    ADMIN_PASSWORD,
    PORT:                  String(s.port),
    HOST:                  '127.0.0.1',
    LOG_LEVEL:             'warn',
    // A real deployment knob (Settings → Network), not a test hook: the mock provider
    // lives on loopback, which the SSRF guard rightly blocks by default.
    SSRF_ALLOWLIST:        '127.0.0.1',
  };
}
