/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Import ORDER is load-bearing here, and nothing else can check it.
//
// `bootGuard` pins DATABASE_URL and REDIS_URL so that a later `.env` load cannot set a variable the
// operator deliberately left out. That only works while the pin runs before anything reaches
// `@prisma/client`, and imports are evaluated in source order before any statement in the importing
// module — so the guarantee is a property of two files' import lists, not of any function.
//
// It cannot be tested by importing the modules: `bootGuard` calls process.exit on a bad
// configuration, which inside a test run kills the runner. So this reads the source, which is also
// the honest thing to check — the risk being guarded against is an editor tidying imports, and
// tidied imports are exactly what a source read sees.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8');

/** Every module specifier imported by a file, in source order, comments excluded. */
function importsOf(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => {
      const m = /^\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/.exec(line);
      return m ? [m[1]] : [];
    });
}

describe('bootGuard runs before anything can load an env file', () => {
  it('imports nothing but lib/mode', () => {
    // Anything else could reach @prisma/client transitively, and would then be evaluated BEFORE the
    // pin regardless of where the pin sits in this file. lib/mode is safe because it imports only
    // node:path — a property its own header commits to.
    expect(importsOf(read('bootGuard.ts'))).toEqual(['./lib/mode']);
  });

  it('calls pinStorageEnv at module scope, not from an exported function', () => {
    // Inside logMode() it would run after the whole import graph, which is far too late.
    const body = read('bootGuard.ts')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'));
    const call = body.findIndex((l) => /^pinStorageEnv\(\);/.test(l));
    expect(call, 'pinStorageEnv() must be a top-level statement in bootGuard.ts').toBeGreaterThan(-1);
  });

  it('pins before it resolves', () => {
    // Against the CALL, `= check()`, not the declaration `function check()` further up the file —
    // resolution happens where MODE is initialised, and that is the moment the pin must precede.
    const src = read('bootGuard.ts');
    expect(src.indexOf('pinStorageEnv();')).toBeLessThan(src.indexOf('= check();'));
  });
});

describe('server.ts loads the guard before the application', () => {
  it('imports dotenv first and the guard second', () => {
    const imports = importsOf(read('server.ts'));
    expect(imports[0]).toBe('dotenv/config');
    expect(imports[1]).toBe('./bootGuard');
  });

  it('reaches nothing that loads Prisma ahead of the guard', () => {
    // A named check on top of the positional one above: this is the failure it exists to prevent,
    // and naming it means a future reader sees WHY the order matters, not just that it does.
    const imports = importsOf(read('server.ts'));
    const guard = imports.indexOf('./bootGuard');
    expect(imports.slice(0, guard).filter((s) => s !== 'dotenv/config')).toEqual([]);
  });
});
