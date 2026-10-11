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

// ── The core boundary check (P0.5a) ───────────────────────────────────────────────────────────
//
//   npm run check:core-boundary    exit 1 if the core can reach anything it must not (CI)
//
// The gateway core (src/core/index.ts and everything it loads) is what the hosted gateway runs
// with its own storage, and what `@alayrasystems/nexus-core` will ship. It must not load a
// database client, a host adapter, an HTTP route, the server, or a package the package would not
// declare. ESLint already stops src/core/ itself from importing Prisma; this check follows the
// imports all the way down, which is where the last leaks were (a service that recorded usage AND
// ran the dashboard's Prisma queries).

import { resolve } from 'node:path';
import { checkBoundary, type BoundaryRules } from './coreBoundary';

const ROOT  = resolve(__dirname, '..', '..');
const ENTRY = 'src/core/index.ts';

// ── The rules ─────────────────────────────────────────────────────────────────────────────────

export const CORE_RULES: BoundaryRules = {
  forbiddenFiles: [
    /^src\/lib\/prisma(Cli)?\.ts$/,                 // the database client and its CLI wrapper
    /^src\/adapters\//,                              // host storage; the host installs it
    /^src\/(routes|middleware)\//,                   // HTTP surface and authentication belong to the host
    /^src\/(server|cli|bootGuard)\.ts$/,             // the open-source process itself
    /\.test\.ts$/,                                   // tests are never part of the core
  ],
  // Every package the core loads at runtime. Adding one is a deliberate act: it becomes a
  // dependency of the published package, so it is reviewed here rather than slipping in.
  allowedPackages: new Set([
    '@opentelemetry/api',                            // tracing spans (a no-op unless the host registers a tracer)
    'ioredis',                                       // the key-value store (rate windows, breakers, cache)
    'js-tiktoken',                                   // token counting when a provider reports none
    'prom-client',                                   // Prometheus metrics
  ]),
};

// ── Running it ────────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const report = checkBoundary(ROOT, ENTRY, CORE_RULES);
  if (report.violations.length) {
    console.error(`Core boundary check failed (${report.violations.length}):`);
    for (const v of report.violations) {
      console.error(`  ${v.reason}`);
      console.error(`    via ${v.chain.join('\n      -> ')}`);
    }
    process.exit(1);
  }
  console.log(`Core boundary check passed: ${report.files.length} files reachable from ${ENTRY}; `
    + `packages: ${report.packages.join(', ') || 'none'}.`);
}
