#!/usr/bin/env node
/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 * Licensed under the Apache License, Version 2.0. See LICENSE at the repository root.
 */

// Generate the two Prisma clients when this package is installed (Phase S4).
//
// WHY THIS RUNS AT INSTALL RATHER THAN SHIPPING PRE-BUILT: the generated clients are 78 MB, and
// each one carries a query engine compiled for one specific platform. Shipping them would mean
// bundling six platforms' engines — well over 100 MB in a package whose own payload is 2 MB. So
// they are built on the machine that will run them, for the platform it actually is.
//
// WHY IT CAN DO NOTHING AND STILL SUCCEED: `npm ci` in the Dockerfile runs BEFORE `COPY prisma/`,
// in both the builder and the runtime stage. A postinstall that insisted on a schema would break
// the image build outright. "Generate the schemas this package has" is the correct rule, and when
// this package has none there is nothing to do. That is not a silent failure either — the launcher
// resolves both clients before it starts anything and says exactly what to run if they are absent.

'use strict';

var path = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..', '..');

var SCHEMAS = [
  path.join(ROOT, 'prisma', 'schema.prisma'),
  path.join(ROOT, 'prisma', 'schema.sqlite.prisma'),
];

var present = SCHEMAS.filter(function (s) { return fs.existsSync(s); });

if (present.length === 0) {
  // Nothing to generate. Quiet on purpose: this is the normal path inside a container build, and a
  // warning there would be noise that teaches people to ignore warnings.
  process.exit(0);
}

if (present.length !== SCHEMAS.length) {
  // One but not both. That is a broken package rather than a stage of a build, and generating half
  // the clients would produce a gateway that starts and then fails on one engine.
  console.error('✖  alayra-nexus: expected both Prisma schemas, found ' + present.length + '.');
  console.error('   ' + present.join('\n   '));
  process.exit(1);
}

// Prisma's own entry point, not `npx prisma`. npx may reach the network or a different version;
// this resolves the CLI that was installed alongside us, which is the one the client was built for.
var cli;
try {
  cli = require.resolve('prisma/build/index.js');
} catch {
  console.error('✖  alayra-nexus: the Prisma CLI is not installed, so the database client cannot');
  console.error('   be generated. This usually means installation skipped lifecycle scripts.');
  process.exit(1);
}

for (var i = 0; i < SCHEMAS.length; i++) {
  var result = spawnSync(process.execPath, [cli, 'generate', '--schema', SCHEMAS[i]], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('✖  alayra-nexus: prisma generate failed for ' + path.basename(SCHEMAS[i]) + '.');
    // Fatal on purpose. A package that installs "successfully" and then cannot open a database has
    // moved the failure to the point where it is hardest to diagnose.
    process.exit(result.status === null ? 1 : result.status);
  }
}
