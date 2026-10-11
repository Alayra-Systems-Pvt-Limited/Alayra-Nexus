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

// ── Design-token checks ───────────────────────────────────────────────────────────────────────
//
//   npm run check:tokens    (also runs `tokens:build -- --check`)
//
// 1. Contrast: every declared pair, in every theme, meets its WCAG minimum (4.5:1 for text,
//    3:1 for focus rings, toggles and other non-text marks).
// 2. No stray colours: the dashboard may not write a hex, rgb() or hsl() colour anywhere but the
//    generated tokens.css. A colour that bypasses the tokens is a colour no contrast check sees.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { colors, contrastChecks, contrastRatio, type ThemeName } from '../../packages/ui-tokens/src';

const ROOT = resolve(__dirname, '..', '..');
const errors: string[] = [];

// ── 1. Contrast ───────────────────────────────────────────────────────────────────────────────

let pairs = 0;
for (const theme of Object.keys(colors) as ThemeName[]) {
  for (const check of contrastChecks) {
    const fg = colors[theme][check.fg];
    const bg = colors[theme][check.bg];
    if (!fg || !bg) { errors.push(`${theme}: ${check.label} names a token that does not exist.`); continue; }
    const ratio = contrastRatio(fg, bg);
    pairs += 1;
    if (ratio < check.min) {
      errors.push(`${theme}: ${check.label} is ${ratio.toFixed(2)}:1 (${check.fg} ${fg} on ${check.bg} ${bg}); needs ${check.min}:1.`);
    }
  }
}

// ── 2. No stray colours in the dashboard ──────────────────────────────────────────────────────

const SCAN_ROOT = 'web/src';
const EXTENSIONS = new Set(['.css', '.ts', '.tsx']);
const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;
/** Files allowed a literal, each with the reason. Keep this list short. */
const ALLOWED: Record<string, string> = {
  'web/src/styles/tokens.css': 'the generated token file itself',
  'web/src/ui/QrCode.tsx': 'a QR code must be pure black on white for scanners',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (EXTENSIONS.has(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

let scanned = 0;
for (const file of walk(resolve(ROOT, SCAN_ROOT))) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (ALLOWED[rel]) continue;
  scanned += 1;
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    // Comments may quote a colour while explaining one.
    const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '');
    for (const match of code.matchAll(COLOUR)) {
      errors.push(`${rel}:${index + 1}: colour literal "${match[0]}" — use a token from tokens.css.`);
    }
  });
}

if (errors.length) {
  console.error(`Design-token check failed (${errors.length}):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`Design-token check passed: ${pairs} contrast pairs across ${Object.keys(colors).length} themes, ${scanned} files free of colour literals.`);
