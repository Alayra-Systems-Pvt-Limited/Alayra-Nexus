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

//   npm run smoke:npx
//
// Proves the PACKAGE, not the repository (Phase S4).
//
// Every other test in this project runs against a working tree that has been built, installed and
// configured by us. None of that exists for someone typing `npx alayra-nexus` — they get a tarball,
// whatever `files` let out of it, and a postinstall. So this packs the real package, installs the
// tarball into an empty directory, and runs the binary npm puts on the PATH.
//
// It also measures. The install is the entire first impression, and its weight is the one honest
// risk in this phase, so the numbers are printed rather than guessed at.
//
// Deliberately hostile in two ways: the gateway is launched from a directory containing a `.env`
// that sets DATABASE_URL and REDIS_URL, and it is launched twice over the same data directory.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3401);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'owner@npx.test';
const PASSWORD = 'a-long-enough-password-1';

let failures = 0;
let token = '';

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

interface Res { status: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Every request is on a clock.
 *
 * Node's fetch has no default timeout, so a request that never comes back hangs the whole script
 * with no output — which is exactly what happened on the first full run: it sat for 36 minutes
 * after the last check with the gateway idle, and had to be killed to find out where it stopped.
 * A test that can hang forever costs more than the bug it was meant to catch.
 */
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let payload: unknown = null;
    try { payload = await r.json(); } catch { /* some routes answer with no body */ }
    return { status: r.status, body: payload };
  } catch (e) {
    return { status: 0, body: { error: `${method} ${path} did not answer: ${(e as Error).message}` } };
  }
}

async function waitForBoot(child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The gateway exited with code ${child.exitCode}.\n\n${log()}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The gateway did not answer within 90s.\n\n${log()}`);
}

/** Total bytes under a directory. Used to report what an install actually costs. */
function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(p);
    else if (entry.isFile()) { try { total += statSync(p).size; } catch { /* vanished */ } }
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'nexus-npx-'));
  const project = join(work, 'someones-project');   // where the gateway is launched from
  const dataDir = join(work, 'gateway-data');       // where it is told to keep its own things
  let child: ChildProcess | null = null;

  /**
   * Kill the gateway and everything it spawned, then remove the workspace.
   *
   * `child.kill()` is not enough on Windows. The binary is a `.cmd`, so it is launched through a
   * shell, and the signal reaches that shell rather than the node process underneath it — leaving
   * a gateway holding a port and an open SQLite file long after the test reported success. The
   * first full run left one alive for 39 minutes, which read from the outside as a test that was
   * still going. `taskkill /T` walks the tree.
   *
   * The removal then retries, because Windows refuses to unlink a file whose handle has not yet
   * been released, and that release is not instantaneous after the process dies.
   */
  const cleanup = () => {
    if (child?.pid) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(work, { recursive: true, force: true }); return; } catch { /* handle still open */ }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)']);   // a portable short wait
    }
    console.log(`  note: could not remove ${work} — remove it by hand`);
  };

  try {
    // ── 1. Pack the real package ─────────────────────────────────────────────────────────────
    // `prepack` builds the gateway and the dashboard first, which is the only reason web/dist —
    // gitignored, and absent from a clean checkout — can be in the tarball at all.
    console.log('\n── Packing ──\n');
    const packed = spawnSync('npm', ['pack', '--pack-destination', work], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    });
    if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);
    const tarball = join(work, packed.stdout.trim().split('\n').pop()!.trim());
    check('the package packs', existsSync(tarball), `${mb(statSync(tarball).size)} compressed`);

    // ── 2. What escaped into the tarball ─────────────────────────────────────────────────────
    // `--ignore-scripts` so this does not run `prepack` a second time: its build output goes to
    // stdout, and mixing a vite banner into the JSON is not a packaging failure but reads like one.
    // The listing is still accurate — the real pack above already produced everything.
    const listing = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    });
    const json = listing.stdout.slice(listing.stdout.indexOf('['));
    const files: string[] = JSON.parse(json)[0].files.map((f: { path: string }) => f.path);

    for (const required of ['bin/alayra-nexus.js', 'dist/cli.js', 'dist/server.js',
                            'prisma/sqlite-schema.sql', 'web/dist/index.html', 'LICENSE']) {
      check(`ships ${required}`, files.includes(required));
    }

    // An allowlist is only as good as what it excludes. `.env` is the one that would be a breach
    // rather than a bug, so it is asserted rather than assumed.
    for (const forbidden of ['.env', '.npmrc', 'docker-compose.yml']) {
      check(`does not ship ${forbidden}`, !files.includes(forbidden));
    }
    for (const prefix of ['src/', 'node_modules/', 'e2e/', 'coverage/', '.github/']) {
      const leaked = files.filter((f) => f.startsWith(prefix));
      check(`ships nothing under ${prefix}`, leaked.length === 0, leaked.slice(0, 3).join(', '));
    }

    // ── 3. Install it the way a stranger would ───────────────────────────────────────────────
    console.log('\n── Installing ──\n');
    spawnSync('npm', ['init', '-y'], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' });

    const started = Date.now();
    const install = spawnSync('npm', ['install', tarball, '--no-audit', '--no-fund'], {
      cwd: work, encoding: 'utf8', shell: process.platform === 'win32',
    });
    const installSeconds = ((Date.now() - started) / 1000).toFixed(1);
    if (install.status !== 0) throw new Error(`npm install failed:\n${install.stdout}\n${install.stderr}`);
    check('the tarball installs', true, `${installSeconds}s`);

    const modules = join(work, 'node_modules');
    console.log(`       installed size — ${mb(sizeOf(modules))} on disk`);

    // The postinstall's whole job. Without these the launcher refuses to start, by design.
    check('the postinstall generated the Postgres client', existsSync(join(modules, '.prisma', 'client')));
    check('the postinstall generated the SQLite client',
      existsSync(join(modules, 'alayra-nexus', 'node_modules', '.prisma', 'client-sqlite'))
      || existsSync(join(modules, '.prisma', 'client-sqlite')));

    const bin = join(modules, '.bin', process.platform === 'win32' ? 'alayra-nexus.cmd' : 'alayra-nexus');
    check('npm put the binary on the PATH', existsSync(bin));

    // ── 4. Launch it from a directory that is not ours ───────────────────────────────────────
    // A .env belonging to somebody else's project. If any of it reaches the gateway, the run below
    // dies trying to contact a Postgres and a Redis that do not exist — which is the point.
    spawnSync('node', ['-e', 'require("fs").mkdirSync(process.argv[1],{recursive:true})', project]);
    writeFileSync(join(project, '.env'),
      'DATABASE_URL=postgresql://nobody@127.0.0.1:1/decoy\nREDIS_URL=redis://127.0.0.1:1\nADMIN_PASSWORD=someone-elses\n');

    console.log('\n── Running ──\n');
    let output = '';
    child = spawn(bin, ['--data-dir', dataDir, '--port', String(PORT)], {
      cwd: project,
      env: { ...process.env, NEXUS_DATA_DIR: '', NODE_ENV: 'production', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });

    await waitForBoot(child, () => output);

    check('it said this was a first run', /first run/.test(output));
    check('it generated an encryption key', existsSync(join(dataDir, 'secret.key')));
    check('it generated an admin password', existsSync(join(dataDir, 'admin-password')));
    check('it created the database in the data directory', existsSync(join(dataDir, 'nexus.db')));
    check('it wrote nothing into the launch directory',
      !existsSync(join(project, '.nexus')) && !existsSync(join(project, 'nexus.db')));

    // The promise the launcher makes out loud.
    check('it said which stray variables it ignored', /DATABASE_URL/.test(output) && /not used/.test(output),
      output.split('\n').find((l) => l.includes('not used'))?.trim() ?? 'no such line');

    const password = readFileSync(join(dataDir, 'admin-password'), 'utf8').trim();
    check('the printed password is the one it kept', output.includes(password));

    // ── 5. It is a real gateway ──────────────────────────────────────────────────────────────
    const ready = await req('GET', '/ready');
    check('it is ready', ready.status === 200, JSON.stringify(ready.body?.checks?.map((c: { label: string }) => c.label)));
    check('on SQLite and in-process memory', /SQLite/.test(output) && /memory/i.test(output));

    check('the gateway reports itself unclaimed',
      (await req('GET', '/admin/setup/status')).body?.unclaimed === true);

    const claim = await req('POST', '/admin/setup/claim',
      { masterPassword: password, email: EMAIL, password: PASSWORD, name: 'Owner' });
    check('the generated password claims the gateway', claim.status === 200, JSON.stringify(claim.body));
    check('claiming returns a recovery key', typeof claim.body?.recoveryKey === 'string');

    const login = await req('POST', '/admin/login', { email: EMAIL, password: PASSWORD });
    token = (login.body as { token?: string })?.token ?? '';
    check('the owner can sign in', login.status === 200 && token.length > 0, JSON.stringify(login.body));

    // A representative slice, not the whole surface — the standalone smoke already drives all
    // eighteen dashboard reads. What this one is proving is that they work from an INSTALLED
    // package, where dist, the dashboard bundle and the generated clients all had to survive `files`.
    for (const path of ['/admin/overview', '/admin/nexus/overview', '/admin/teams',
                        '/admin/health/overview', '/admin/analytics/overview']) {
      const r = await req('GET', path);
      check(`the dashboard read ${path} answers`, r.status === 200, r.status === 200 ? '' : JSON.stringify(r.body));
    }

    const dash = await fetch(`${BASE}/`);
    const html = await dash.text();
    check('the dashboard itself is served from the package', dash.ok && /<div id="app">|<script/.test(html));

    // ── 6. A second gateway on the same directory is refused ─────────────────────────────────
    const second = spawnSync(bin, ['--data-dir', dataDir, '--port', String(PORT + 1)], {
      cwd: project, encoding: 'utf8', shell: process.platform === 'win32',
      env: { ...process.env, NEXUS_DATA_DIR: '' },
    });
    check('a second gateway on the same data directory is refused',
      second.status !== 0 && /already running/.test(second.stdout + second.stderr),
      (second.stdout + second.stderr).split('\n').find((l) => l.includes('already running'))?.trim() ?? '');

    // ── 7. Flags that must not touch anything ────────────────────────────────────────────────
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    check('--version prints a version and exits 0',
      version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), version.stdout.trim());

    const bad = spawnSync(bin, ['--pot', '3001'], { encoding: 'utf8', shell: process.platform === 'win32' });
    check('an unknown flag is refused rather than ignored',
      bad.status !== 0 && /Unknown option/.test(bad.stdout + bad.stderr));

    check('the owner can sign out', (await req('POST', '/admin/logout')).status === 200);

    console.log('');
    if (failures > 0) {
      console.error(`✖  ${failures} check(s) failed\n`);
      console.error(output);
      process.exitCode = 1;
    } else {
      console.log(`✔ npx alayra-nexus works end to end — installed in ${installSeconds}s\n`);
    }
  } catch (err) {
    console.error(`\n✖  ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

void main();
