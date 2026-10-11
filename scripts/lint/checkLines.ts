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

// ── The file-size ratchet ─────────────────────────────────────────────────────────────────────
//
//   npm run check:lines               exit 1 if any file breaks the budget (CI)
//   npm run check:lines -- --update   lower the budget to match files that have shrunk
//
// ── The rule ──────────────────────────────────────────────────────────────────────────────────
//
// No source file over 300 lines. A file that size is doing more than one job, and the proxy that
// prompted this rule had grown to 744 lines because nothing stopped the next 20 from landing.
//
// Files already over the limit when the rule arrived are listed in line-budget.json with their
// size on that day. They may shrink, never grow, and a new file may never join them. `--update`
// only ever lowers a number or drops an entry that has come under the limit; it cannot raise one
// or add one, so the budget can only get smaller.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';

const ROOT   = resolve(__dirname, '..', '..');
const BUDGET = resolve(__dirname, 'line-budget.json');
const LIMIT  = 300;

/** Where source lives. Build output and dependencies are never walked. */
const ROOTS      = ['src', 'scripts', 'web/src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css']);
const SKIP_DIRS  = new Set(['node_modules', 'dist', 'generated', 'coverage']);

// ── Measuring ─────────────────────────────────────────────────────────────────────────────────

/** Lines as an editor shows them: a final newline does not start another line. */
function countLines(file: string): number {
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** Every source file under the roots, as a repository-relative path with forward slashes. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (EXTENSIONS.has(extname(entry.name))) {
        out.push(relative(ROOT, join(dir, entry.name)).split('\\').join('/'));
      }
    }
  };
  for (const root of ROOTS) if (existsSync(resolve(ROOT, root))) walk(resolve(ROOT, root));
  return out.sort();
}

// ── Checking ──────────────────────────────────────────────────────────────────────────────────

const budget: Record<string, number> = JSON.parse(readFileSync(BUDGET, 'utf8'));
const sizes = new Map(sourceFiles().map((f) => [f, countLines(resolve(ROOT, f))]));
const errors: string[] = [];
/** Files that shrank but are still over: fine, and worth lowering the budget to. */
const shrunk: string[] = [];
/** Entries that no longer guard anything: an error, since each is headroom to grow back into. */
const stale:  string[] = [];
const next:   Record<string, number> = {};

for (const [file, lines] of sizes) {
  const allowed = budget[file];
  if (allowed === undefined) {
    if (lines > LIMIT) errors.push(`${file}: ${lines} lines (limit ${LIMIT}). Split it; new files cannot join the budget.`);
  } else if (lines > allowed) {
    errors.push(`${file}: ${lines} lines, budget ${allowed}. A file over the limit may only shrink.`);
  } else if (lines > LIMIT) {
    next[file] = lines;
    if (lines < allowed) shrunk.push(`${file}: ${allowed} -> ${lines}`);
  } else {
    stale.push(`${file}: now ${lines}, under the limit; its budget entry is no longer needed`);
  }
}
// A budget entry for a file that is gone would let a new file by that name start oversized.
for (const file of Object.keys(budget)) {
  if (!sizes.has(file)) stale.push(`${file}: no longer exists; its budget entry is no longer needed`);
}

const UPDATE_HINT = 'run `npm run check:lines -- --update`';
if (process.argv.includes('--update')) {
  writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`line-budget.json: ${Object.keys(next).length} file(s) over ${LIMIT} lines.`);
  for (const n of [...shrunk, ...stale]) console.log(`  updated  ${n}`);
} else {
  for (const n of stale)  errors.push(`${n} (${UPDATE_HINT})`);
  for (const n of shrunk) console.log(`  shrank   ${n} (${UPDATE_HINT} to lock it in)`);
}

if (errors.length) {
  console.error(`File-size check failed (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`File-size check passed: ${sizes.size} files, ${Object.keys(budget).length} grandfathered over ${LIMIT} lines.`);
