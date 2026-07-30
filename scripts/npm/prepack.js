#!/usr/bin/env node
/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 * Licensed under the Apache License, Version 2.0. See LICENSE at the repository root.
 */

// Build everything the tarball is supposed to contain, before npm reads the directory (Phase S4).
//
// `files` lists `dist` and `web/dist`. Both are gitignored build output, so a publish from a clean
// checkout would otherwise ship a package with no gateway and no dashboard — and it would ship
// quietly, because an allowlist that names a missing directory is not an error.
//
// The dashboard's dependencies are installed ONLY when they are absent. The obvious
// `npm --prefix web ci` deletes and reinstalls web/node_modules every time, which on a maintainer's
// machine throws away several minutes for no gain and, on Windows, fails outright when a running
// dev server holds a native binding open. `npm pack` has to be something a maintainer can run
// without consequences, or it stops being run before publishing.

'use strict';

var path = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..', '..');
var WEB = path.join(ROOT, 'web');

function run(args, cwd, what) {
  var result = spawnSync('npm', args, {
    cwd: cwd,
    stdio: 'inherit',
    // npm is a .cmd on Windows and cannot be executed directly.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error('\n✖  prepack: ' + what + ' failed.\n');
    process.exit(result.status === null ? 1 : result.status);
  }
}

run(['run', 'build'], ROOT, 'building the gateway');

if (!fs.existsSync(path.join(WEB, 'node_modules'))) {
  console.log('\nprepack: installing the dashboard\'s dependencies (none present)\n');
  run(['ci'], WEB, 'installing dashboard dependencies');
}

run(['run', 'build'], WEB, 'building the dashboard');

// An allowlist naming a missing directory is not an npm error, so check here instead. Shipping a
// package whose dashboard is a 404 is the failure this whole script exists to prevent.
var required = [
  path.join(ROOT, 'dist', 'cli.js'),
  path.join(ROOT, 'dist', 'server.js'),
  path.join(WEB, 'dist', 'index.html'),
  path.join(ROOT, 'prisma', 'sqlite-schema.sql'),
];

var missing = required.filter(function (f) { return !fs.existsSync(f); });
if (missing.length > 0) {
  console.error('\n✖  prepack: the build did not produce:\n   ' + missing.join('\n   ') + '\n');
  process.exit(1);
}
