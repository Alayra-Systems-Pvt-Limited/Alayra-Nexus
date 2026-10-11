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

// ── The core boundary, as a pure function (P0.5a) ─────────────────────────────────────────────
// Walks every RUNTIME import reachable from an entry file and reports each one that crosses the
// boundary: a forbidden local file (a database client, a host adapter, a route, the server) or a
// package that is not on the allowlist. `checkCoreBoundary.ts` is the command; this file holds the
// logic so the tests can drive it against small fixture trees.
//
// Parsed with the TypeScript compiler, not a regex, because the distinction that matters here is
// one a regex gets wrong: `import type { X }` and an import whose every name is `type` vanish from
// the compiled output, so they may reach anything; everything else really loads at runtime.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface BoundaryRules {
  /** Repository-relative paths (forward slashes) the core may never load. */
  forbiddenFiles: readonly RegExp[];
  /** npm packages the core may load at runtime. Node built-ins are always allowed. */
  allowedPackages: ReadonlySet<string>;
}

export interface Violation {
  /** The import path that leads to the problem, entry first. */
  chain:  string[];
  reason: string;
}

export interface BoundaryReport {
  files:      string[];
  packages:   string[];
  violations: Violation[];
}

// ── Reading the runtime imports of one file ───────────────────────────────────────────────────

/** True when every named binding is `type`, so TypeScript drops the whole statement. */
function onlyTypeNames(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;                         // `import 'x'` runs x
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;                     // a default import is a value
  const bindings = clause.namedBindings;
  return !!bindings && ts.isNamedImports(bindings) && onlyTypeNames(bindings.elements);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return !!clause && ts.isNamedExports(clause) && onlyTypeNames(clause.elements);
}

/** Module specifiers this file loads when it runs: static, re-exported, dynamic and require(). */
export function runtimeImports(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const literal = (n: ts.Node | undefined): void => { if (n && ts.isStringLiteralLike(n)) found.push(n.text); };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) literal(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!isTypeOnlyExport(node)) literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(callee) && callee.text === 'require';
      if (dynamic || required) literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ── Resolving a specifier ─────────────────────────────────────────────────────────────────────

const BUILTINS = new Set(builtinModules);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(packageName(specifier));
}

/** The file a relative specifier loads, as the compiled CommonJS would find it. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ── Walking the graph ─────────────────────────────────────────────────────────────────────────

/**
 * Breadth-first from `entry`, so every reported chain is the shortest way the core reaches the
 * problem — the link to cut is then usually the second-to-last one.
 */
export function checkBoundary(root: string, entry: string, rules: BoundaryRules): BoundaryReport {
  const rel = (abs: string): string => relative(root, abs).split('\\').join('/');
  const start = resolve(root, entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const packages = new Set<string>();
  const violations: Violation[] = [];

  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) chain.unshift(rel(at));
    return chain;
  };

  while (queue.length) {
    const file = queue.shift() as string;
    const forbidden = rules.forbiddenFiles.find((re) => re.test(rel(file)));
    if (forbidden) {
      violations.push({ chain: chainTo(file), reason: `the core must not load ${rel(file)}` });
      continue;                                       // its own imports are not the core's problem
    }
    if (!/\.tsx?$/.test(file)) continue;              // JSON and the like: loaded, but import nothing

    for (const specifier of runtimeImports(file, readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = resolveLocal(file, specifier);
        if (!target) {
          violations.push({ chain: chainTo(file), reason: `cannot resolve '${specifier}'` });
        } else if (!parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      } else if (!isBuiltin(specifier)) {
        const name = packageName(specifier);
        if (rules.allowedPackages.has(name)) packages.add(name);
        else violations.push({ chain: chainTo(file), reason: `package '${name}' is not on the core allowlist` });
      }
    }
  }

  return { files: [...parent.keys()].map(rel).sort(), packages: [...packages].sort(), violations };
}
