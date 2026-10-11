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

// ── Build @alayrasystems/nexus-core (P0.5c) ───────────────────────────────────────────────────
//
//   npm run core:build
//
// Compiles the core straight from this repository's src/ (packages/nexus-core/tsconfig.json names
// the two public entries; tsc follows their imports) into packages/nexus-core/dist, with type
// declarations, and copies the licence files beside it. The previous dist/ is replaced, never
// merged into, so a module the core stopped loading cannot linger in the package.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const PKG  = join(ROOT, 'packages', 'nexus-core');

// ── A clean output directory: build output only, never source ──
rmSync(join(PKG, 'dist'), { recursive: true, force: true });

// ── Compile ──
const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'tsconfig.json')], {
  cwd: ROOT, stdio: 'inherit',
});
if (tsc.status !== 0) {
  console.error('nexus-core: tsc failed.');
  process.exit(tsc.status ?? 1);
}

// ── The licence travels with the package ──
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(ROOT, file), join(PKG, file));

if (!existsSync(join(PKG, 'dist', 'core', 'index.js')) || !existsSync(join(PKG, 'dist', 'core', 'testing', 'index.js'))) {
  console.error('nexus-core: build finished but an entry point is missing from dist/core.');
  process.exit(1);
}
console.log('nexus-core: built packages/nexus-core/dist');
