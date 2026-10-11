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

// ── Generate tokens.css ───────────────────────────────────────────────────────────────────────
//
//   npm run tokens:build                write tokens.css from packages/ui-tokens/src/tokens.ts
//   npm run tokens:build -- --check     exit 1 if a committed copy is stale (CI)
//
// Two copies are written: the package's own, and the dashboard's. The dashboard keeps importing
// its local file, so its build needs no path outside web/ and nothing in its config changes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTokensCss } from '../../packages/ui-tokens/src';

const ROOT = resolve(__dirname, '..', '..');
const TARGETS = [
  'packages/ui-tokens/tokens.css',
  'web/src/styles/tokens.css',
];

const css = renderTokensCss();
// Compared without carriage returns, so a Windows checkout with autocrlf is not "stale".
const normalise = (text: string): string => text.replace(/\r\n/g, '\n');

if (process.argv.includes('--check')) {
  const stale = TARGETS.filter((target) => {
    const file = resolve(ROOT, target);
    return !existsSync(file) || normalise(readFileSync(file, 'utf8')) !== css;
  });
  if (stale.length) {
    console.error(`tokens.css is out of date in: ${stale.join(', ')} — run \`npm run tokens:build\`.`);
    process.exit(1);
  }
  console.log(`tokens.css is current in ${TARGETS.length} places.`);
} else {
  for (const target of TARGETS) writeFileSync(resolve(ROOT, target), css);
  console.log(`Wrote ${TARGETS.join(' and ')}.`);
}
