#!/usr/bin/env node
/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 * Licensed under the Apache License, Version 2.0. See LICENSE at the repository root.
 */

// The published entry point. Deliberately the smallest thing that can run.
//
// Everything real is in `src/cli.ts`, compiled to `dist/cli.js`, so the launcher is typechecked,
// linted and unit-tested like the rest of the codebase. What stays here is only what cannot be:
// the shebang, and the two failures that happen BEFORE any of our compiled code could report them.

'use strict';

// 1. Node too old to run what follows. `engines` in package.json only warns, and the error a modern
//    syntax feature produces on an old runtime is a SyntaxError pointing at a file the user did not
//    write. Node 20 went end-of-life in April 2026; 22 is what this project builds and tests on.
var MIN_MAJOR = 22;
var major = Number(process.versions.node.split('.')[0]);
if (major < MIN_MAJOR) {
  console.error('\n✖  Alayra Nexus needs Node ' + MIN_MAJOR + ' or newer.');
  console.error('   This is Node ' + process.versions.node + '.');
  console.error('   Node 20 reached end of life in April 2026.\n');
  process.exit(1);
}

// 2. No build. Only reachable from a source checkout — a published package always ships `dist`,
//    because `files` includes it and `prepack` builds it. Saying so beats MODULE_NOT_FOUND.
var cli;
try {
  cli = require('../dist/cli.js');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).indexOf('dist/cli') !== -1) {
    console.error('\n✖  This checkout has not been built.');
    console.error('   Run:  npm install && npm run build\n');
    process.exit(1);
  }
  throw err;
}

cli.main().catch(function (err) {
  // The launcher reports its own expected failures and exits. Anything arriving here is a bug, and
  // a bug keeps its stack.
  console.error('\n✖  Alayra Nexus failed to start.\n');
  console.error(err);
  process.exit(1);
});
