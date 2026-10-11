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

// The core boundary check (P0.5a), driven against small fixture trees: what counts as a runtime
// import, what a violation looks like, and — last — that the real core passes today.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkBoundary, runtimeImports, packageName, type BoundaryRules } from './coreBoundary';
import { CORE_RULES } from './checkCoreBoundary';

// ── Fixture trees ─────────────────────────────────────────────────────────────────────────────

const RULES: BoundaryRules = {
  forbiddenFiles:  [/^db\.ts$/],
  allowedPackages: new Set(['ok-pkg']),
};

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** Writes `files` into a fresh temporary directory and returns its path. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'core-boundary-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const DB = { 'db.ts': 'export const db = 1;\nexport type Row = { id: string };\n' };

// ── What counts as a runtime import ───────────────────────────────────────────────────────────

describe('runtimeImports', () => {
  it('ignores imports and re-exports that only carry types', () => {
    const text = [
      "import type { Row } from './a';",
      "import { type Row as R2 } from './b';",
      "export type { Row as R3 } from './c';",
      "export { type Row as R4 } from './d';",
    ].join('\n');
    expect(runtimeImports('x.ts', text)).toEqual([]);
  });

  it('keeps value, default, side-effect, star, dynamic and require imports', () => {
    const text = [
      "import { db } from './a';",
      "import d, { type Row } from './b';",
      "import './c';",
      "export * from './d';",
      "const lazy = () => import('./e');",
      "const req = require('./f');",
      "import g = require('./g');",
    ].join('\n');
    expect(runtimeImports('x.ts', text)).toEqual(['./a', './b', './c', './d', './e', './f', './g']);
  });
});

describe('packageName', () => {
  it('keeps the scope and drops the subpath', () => {
    expect(packageName('@prisma/client/runtime')).toBe('@prisma/client');
    expect(packageName('ioredis/built/utils')).toBe('ioredis');
  });
});

// ── The walk ──────────────────────────────────────────────────────────────────────────────────

describe('checkBoundary', () => {
  it('passes when the forbidden file is reached by types only', () => {
    const root = tree({ ...DB, 'entry.ts': "import type { Row } from './db';\nexport const x: Row | null = null;\n" });
    expect(checkBoundary(root, 'entry.ts', RULES).violations).toEqual([]);
  });

  it('reports the shortest chain to a forbidden file', () => {
    const root = tree({
      ...DB,
      'entry.ts': "export * from './mid';\n",
      'mid.ts':   "import { db } from './db';\nexport const y = db;\n",
    });
    expect(checkBoundary(root, 'entry.ts', RULES).violations).toEqual([
      { chain: ['entry.ts', 'mid.ts', 'db.ts'], reason: 'the core must not load db.ts' },
    ]);
  });

  it('catches a forbidden file loaded lazily', () => {
    const root = tree({ ...DB, 'entry.ts': "export const load = () => import('./db');\n" });
    expect(checkBoundary(root, 'entry.ts', RULES).violations).toHaveLength(1);
  });

  it('allows built-ins and listed packages, and names the rest', () => {
    const root = tree({
      'entry.ts': "import 'node:fs';\nimport 'crypto';\nimport 'ok-pkg/sub';\nimport '@acme/bad';\n",
    });
    const report = checkBoundary(root, 'entry.ts', RULES);
    expect(report.packages).toEqual(['ok-pkg']);
    expect(report.violations).toEqual([
      { chain: ['entry.ts'], reason: "package '@acme/bad' is not on the core allowlist" },
    ]);
  });

  it('reports a relative import it cannot resolve rather than skipping it', () => {
    const root = tree({ 'entry.ts': "import './missing';\n" });
    expect(checkBoundary(root, 'entry.ts', RULES).violations[0].reason).toBe("cannot resolve './missing'");
  });
});

// ── The real core ─────────────────────────────────────────────────────────────────────────────

describe('the gateway core', () => {
  it('loads no database client, adapter, route, server code or unlisted package', () => {
    const report = checkBoundary(resolve(__dirname, '..', '..'), 'src/core/index.ts', CORE_RULES);
    expect(report.violations).toEqual([]);
    expect(report.files).not.toContain('src/lib/prisma.ts');
  });
});
