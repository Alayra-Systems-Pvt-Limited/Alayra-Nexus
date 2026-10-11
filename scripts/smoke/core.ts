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

// ── The nexus-core package, packed, installed and driven (P0.5c) ──────────────────────────────
//
//   npm run smoke:core
//
// Proves the PACKAGE rather than the repository, the way smoke:npx does for the server: builds it,
// packs the real tarball, installs that tarball into an empty directory beside nothing but its peer
// (fastify), and then checks what a host would meet:
//
//   1. the tarball holds the build, the licence and the readme — no source, tests or adapters
//   2. installing it pulls in no database client
//   3. both entries load from CommonJS and from ES modules, with the public names present
//   4. the conformance checks pass against the in-memory stores, from the installed copy
//   5. loading the package opens nothing: the process exits on its own
//   6. without MASTER_ENCRYPTION_KEY it refuses to load, with the message the README promises
//   7. a strict TypeScript consumer compiles against the shipped declarations
//
// The temporary directory is this run's own scratch space and is removed at the end.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const PKG  = join(ROOT, 'packages', 'nexus-core');
const WIN  = process.platform === 'win32';
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const corePkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Runs a command and returns its output; a non-zero exit is reported, not thrown. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 300_000, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: WIN && cmd === 'npm', timeout: timeoutMs });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

// ── What a host runs against the installed package ────────────────────────────────────────────

const PUBLIC_NAMES = [
  'configureCoreStores', 'coreStores', 'configureCoreKv', 'handleProxy', 'ProxyError',
  'withProviderStreamUsage', 'dispatchProxy', 'anthropicToOpenAI', 'createAnthropicReply',
  'listServableModels', 'resolveRequestScope',
];
const TESTING_NAMES = ['coreStoresConformance', 'runCoreStoresConformance', 'createMemoryCoreStores', 'CONFORMANCE_FIXTURE'];

const CJS_CHECK = `
const core = require('@alayrasystems/nexus-core');
const testing = require('@alayrasystems/nexus-core/testing');
const missing = ${JSON.stringify(PUBLIC_NAMES)}.filter((n) => typeof core[n] === 'undefined')
  .concat(${JSON.stringify(TESTING_NAMES)}.filter((n) => typeof testing[n] === 'undefined'));
if (missing.length) { console.error('missing exports: ' + missing.join(', ')); process.exit(2); }
let notes = [];
const harness = {
  setup: async (f) => { const m = testing.createMemoryCoreStores(f); notes = m.notifications; return m.stores; },
  notifications: async () => notes,
};
testing.runCoreStoresConformance(harness).then((failed) => {
  console.log('conformance: ' + (testing.coreStoresConformance.length - failed.length) + '/' + testing.coreStoresConformance.length);
  for (const f of failed) console.error('  failed: ' + f.name + ': ' + (f.error && f.error.message));
  process.exitCode = failed.length ? 3 : 0;
});
`;

const ESM_CHECK = `
import { handleProxy, configureCoreKv } from '@alayrasystems/nexus-core';
import { runCoreStoresConformance } from '@alayrasystems/nexus-core/testing';
if (typeof handleProxy !== 'function' || typeof configureCoreKv !== 'function' || typeof runCoreStoresConformance !== 'function') process.exit(4);
console.log('esm named imports: ok');
`;

const TS_CONSUMER = `
import {
  configureCoreStores, configureCoreKv, handleProxy, ProxyError,
  type CoreStores, type TeamContext, type CallerContext, type CompletionsBody, type KeyStore,
} from '@alayrasystems/nexus-core';
import { createMemoryCoreStores, CONFORMANCE_FIXTURE, type CoreStoresHarness } from '@alayrasystems/nexus-core/testing';

const { stores } = createMemoryCoreStores(CONFORMANCE_FIXTURE);
const typed: CoreStores = stores;
const keys: KeyStore = typed.keys;
configureCoreStores(() => typed);
const team: TeamContext = { id: 'team-a', name: 'Alpha', budgetUsd: null, budgetPeriod: 'monthly' };
const caller: CallerContext = { teamKeyId: 'tk-a', team };
const body = { model: 'gpt-x', messages: [] } satisfies Partial<CompletionsBody>;
const harness: CoreStoresHarness = { setup: async () => typed, notifications: async () => [] };
export const used = [configureCoreKv, handleProxy, ProxyError, keys, caller, body, harness];
`;

const TS_CONFIG = JSON.stringify({
  compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022',
    module: 'node16', moduleResolution: 'node16', types: ['node'],
  },
  files: ['consumer.ts'],
}, null, 2);

// ── The run ───────────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('\n── nexus-core package smoke ──\n');
  const build = run(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'scripts', 'core', 'build.ts')], ROOT);
  check('the package builds', build.ok, build.ok ? '' : build.out.slice(-2000));
  if (!build.ok) return;

  const work = mkdtempSync(join(tmpdir(), 'nexus-core-smoke-'));
  try {
    // 1. The tarball's contents
    const packed = run('npm', ['pack', '--json', '--pack-destination', work], PKG);
    check('npm pack succeeds', packed.ok, packed.ok ? '' : packed.out.slice(-2000));
    if (!packed.ok) return;
    const info = JSON.parse(packed.out.slice(packed.out.indexOf('['))) as [{ filename: string; size: number; unpackedSize: number; files: { path: string }[] }];
    const files = info[0].files.map((f) => f.path);
    const allowed = /^(dist\/.+\.(js|d\.ts)|package\.json|README\.md|LICENSE|NOTICE)$/;
    const stray = files.filter((f) => !allowed.test(f) || /\.test\.|\/adapters\/|\/routes\/|lib\/prisma/.test(f));
    check('the tarball holds only the build, licence and readme', stray.length === 0, stray.join(', '));
    for (const need of ['LICENSE', 'NOTICE', 'README.md', 'dist/core/index.js', 'dist/core/index.d.ts', 'dist/core/testing/index.js']) {
      check(`the tarball includes ${need}`, files.includes(need));
    }
    console.log(`        ${files.length} files, ${(info[0].size / 1024).toFixed(1)} kB packed, ${(info[0].unpackedSize / 1024).toFixed(1)} kB unpacked`);

    // 2. Install beside its peer only
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'core-consumer', version: '0.0.0', private: true }));
    const install = run('npm', ['install', join(work, info[0].filename), `fastify@${corePkg.peerDependencies.fastify}`,
      `@types/node@${rootPkg.devDependencies['@types/node']}`, '--no-audit', '--no-fund'], work);
    check('the tarball installs', install.ok, install.ok ? '' : install.out.slice(-2000));
    if (!install.ok) return;
    const nm = join(work, 'node_modules');
    const dbClients = ['@prisma', '.prisma', 'pg', 'better-sqlite3'].filter((d) => existsSync(join(nm, d)));
    check('no database client is installed', dbClients.length === 0, dbClients.join(', '));
    console.log(`        ${readdirSync(nm).filter((d) => !d.startsWith('.')).length} top-level packages in node_modules`);

    // 3–6. Load it, run the checks, and exit on our own. The core decrypts provider keys with a
    // 64-hex MASTER_ENCRYPTION_KEY and refuses to load without one; a throwaway test key is used here.
    const withKey = { ...process.env, MASTER_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
    const noKey = { ...process.env };
    delete noKey.MASTER_ENCRYPTION_KEY;
    writeFileSync(join(work, 'check.cjs'), CJS_CHECK);
    const bare = run(process.execPath, ['check.cjs'], work, 60_000, noKey);
    check('without MASTER_ENCRYPTION_KEY it refuses to load, and says why', !bare.ok && bare.out.includes('MASTER_ENCRYPTION_KEY must be exactly 64 hex characters'));
    const cjs = run(process.execPath, ['check.cjs'], work, 60_000, withKey);
    check('CommonJS: every public name loads and the conformance checks pass', cjs.ok, cjs.out.trim());
    check('loading the package leaves nothing open (the process exited by itself)', cjs.status !== null);
    writeFileSync(join(work, 'check.mjs'), ESM_CHECK);
    const esm = run(process.execPath, ['check.mjs'], work, 60_000, withKey);
    check('ES modules: named imports resolve', esm.ok, esm.out.trim());

    // 7. A strict TypeScript consumer
    writeFileSync(join(work, 'consumer.ts'), TS_CONSUMER);
    writeFileSync(join(work, 'tsconfig.json'), TS_CONFIG);
    const tsc = run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], work);
    check('a strict TypeScript consumer compiles against the declarations', tsc.ok, tsc.out.trim().slice(0, 3000));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
if (failures) {
  console.error(`\n✘ nexus-core smoke failed (${failures})`);
  process.exit(1);
}
console.log('\n✔ nexus-core installs and works from the tarball');
