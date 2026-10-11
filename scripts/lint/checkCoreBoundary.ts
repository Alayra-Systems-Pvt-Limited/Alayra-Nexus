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

// ── The core boundary check (P0.5a; package manifest since P0.5c) ─────────────────────────────
//
//   npm run check:core-boundary    exit 1 if the core can reach anything it must not (CI)
//
// The gateway core (src/core/index.ts, src/core/testing/index.ts and everything they load) is what
// the hosted gateway runs with its own storage, and what `@alayrasystems/nexus-core` ships. It must
// not load a database client, a host adapter, an HTTP route, the server, or a package the package
// does not declare. ESLint already stops src/core/ itself from importing Prisma; this check follows
// the imports all the way down, which is where the last leaks were.
//
// The package's own package.json is the allowlist, so what the core may load and what the package
// installs cannot disagree. It is also held to the root package.json: same ranges, same version.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBoundary, type BoundaryRules } from './coreBoundary';

const ROOT    = resolve(__dirname, '..', '..');
const ENTRIES = ['src/core/index.ts', 'src/core/testing/index.ts'];

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
export const CORE_MANIFEST = readManifest('packages/nexus-core/package.json');
const ROOT_MANIFEST = readManifest('package.json');

// ── The rules ─────────────────────────────────────────────────────────────────────────────────

export const CORE_RULES: BoundaryRules = {
  forbiddenFiles: [
    /^src\/lib\/prisma(Cli)?\.ts$/,                 // the database client and its CLI wrapper
    /^src\/adapters\//,                              // host storage; the host installs it
    /^src\/(routes|middleware)\//,                   // HTTP surface and authentication belong to the host
    /^src\/(server|cli|bootGuard)\.ts$/,             // the open-source process itself
    /\.test\.ts$/,                                   // tests are never part of the core
  ],
  // Adding a package means adding it to packages/nexus-core/package.json, where it becomes a
  // dependency every host installs — so it is a reviewed change, never a silent one.
  allowedPackages: new Set(Object.keys(CORE_MANIFEST.dependencies ?? {})),
};

/** Problems with the package manifest itself, given the packages the core was seen to load. */
export function manifestProblems(loaded: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const rootRange = (name: string) => ROOT_MANIFEST.dependencies?.[name] ?? ROOT_MANIFEST.devDependencies?.[name];

  if (CORE_MANIFEST.version !== ROOT_MANIFEST.version) {
    problems.push(`version ${CORE_MANIFEST.version} differs from @alayrasystems/nexus ${ROOT_MANIFEST.version}; they release together`);
  }
  for (const [name, range] of Object.entries(CORE_MANIFEST.dependencies ?? {})) {
    if (!loaded.has(name)) problems.push(`dependency '${name}' is declared but the core never loads it`);
    if (range !== rootRange(name)) problems.push(`'${name}' is ${range} here but ${rootRange(name) ?? 'absent'} in the root package.json`);
  }
  for (const [name, range] of Object.entries(CORE_MANIFEST.peerDependencies ?? {})) {
    if (range !== rootRange(name)) problems.push(`peer '${name}' is ${range} here but ${rootRange(name) ?? 'absent'} in the root package.json`);
  }
  return problems;
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const reports = ENTRIES.map((entry) => checkBoundary(ROOT, entry, CORE_RULES));
  const violations = reports.flatMap((r) => r.violations);
  const loaded = new Set(reports.flatMap((r) => r.packages));
  const files = new Set(reports.flatMap((r) => r.files));
  const problems = manifestProblems(loaded);

  for (const v of violations) {
    console.error(`  ${v.reason}`);
    console.error(`    via ${v.chain.join('\n      -> ')}`);
  }
  for (const p of problems) console.error(`  packages/nexus-core/package.json: ${p}`);
  if (violations.length || problems.length) {
    console.error(`Core boundary check failed (${violations.length + problems.length}).`);
    process.exit(1);
  }
  console.log(`Core boundary check passed: ${files.size} files reachable from ${ENTRIES.join(' and ')}; `
    + `packages: ${[...loaded].sort().join(', ') || 'none'}; manifest in step with the root.`);
}
