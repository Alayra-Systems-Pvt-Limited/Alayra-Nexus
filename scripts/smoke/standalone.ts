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

// Does a standalone gateway actually work? (Phase S2.4)
//
//   npm run build && npm run smoke:standalone
//
// The COMPILED server, started in an empty directory with no DATABASE_URL and no REDIS_URL —
// exactly what `npx @alayra/nexus` does — then driven over HTTP: it builds its own database, claims
// an owner, signs in, serves every dashboard read, writes, and signs out.
//
// This exists because everything else in the suite tests our code with stand-ins, and standalone
// mode is precisely where stand-ins lie. S1's in-memory KV passed every unit test and every type
// check, then crashed a real boot on a Redis command nothing in our code calls — @fastify/rate-limit
// reached for it through ioredis's defineCommand. No amount of mocking would have found that; one
// real boot did, immediately.
//
// It needs no PostgreSQL, no Redis and no Docker, which is the point: it is the cheapest job in CI
// and the only one that proves the zero-configuration path a first-time user will take.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = 'smoke-master-password';
const EMAIL = 'owner@smoke.test';
const PASSWORD = 'a-long-enough-password-1';

let failures = 0;
let token = '';

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

interface Res { status: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(BASE + path, {
    method,
    // content-type ONLY when there is a body: Fastify answers a POST that declares JSON and sends
    // nothing with a 400, which is correct of it.
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  try { payload = await r.json(); } catch { /* some routes answer with no body */ }
  return { status: r.status, body: payload };
}

/** Poll /health until the gateway answers, so this never races a slow first boot. */
async function waitForBoot(child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The gateway exited with code ${child.exitCode}.\n\n${log()}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The gateway did not answer within 60s.\n\n${log()}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('dist/server.js is missing — run `npm run build` first.');
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'nexus-smoke-'));
  let output = '';

  // An EMPTY working directory, and both URLs explicitly blank. The directory matters as much as
  // the variables: Prisma's client loads a .env next to the schema, so a run from the repo root
  // would silently inherit the developer's Postgres and this would quietly test the wrong engine.
  // That exact mistake produced a passing "standalone" run during S2.0 that was really Postgres.
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js')], {
    cwd: dir,
    env: {
      ...process.env,
      DATABASE_URL: '',
      REDIS_URL: '',
      NEXUS_MODE: '',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      ADMIN_PASSWORD: MASTER,
      MASTER_ENCRYPTION_KEY: 'a'.repeat(64),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => { output += d; });
  child.stderr?.on('data', (d) => { output += d; });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may still hold the file */ }
  };

  try {
    console.log(`\n── A standalone gateway in ${dir} ──\n`);
    await waitForBoot(child, () => output);

    // It built its own database. Nothing else in CI proves this: `prisma db push` is what every
    // other job uses, and a standalone gateway has no CLI to run it with.
    check('the gateway created its own database', /Database created → \d+ tables/.test(output),
      output.split('\n').find((l) => l.includes('Database created')) ?? 'no such line in the log');
    check('it printed an API key on first run', /Generated Nexus API Key/.test(output));

    check('GET /health answers', (await req('GET', '/health')).status === 200);

    const ready = await req('GET', '/ready');
    check('GET /ready is ready', ready.status === 200, `status ${ready.status}`);
    const labels: string[] = (ready.body?.checks ?? []).map((c: { label: string }) => c.label);
    // /ready is read by orchestrators. Naming a Postgres and a Redis that do not exist is the
    // specific dishonesty S1 and S2.3 fixed, one layer each.
    check('/ready names the stores really probed', labels.includes('In-process memory read') && labels.includes('SQLite SELECT 1'),
      labels.join(', '));

    check('the gateway is unclaimed', (await req('GET', '/admin/setup/status')).body?.unclaimed === true);

    const claim = await req('POST', '/admin/setup/claim', { masterPassword: MASTER, name: 'Smoke Owner', email: EMAIL, password: PASSWORD });
    check('claiming creates the first owner', claim.status === 200, `status ${claim.status}`);
    check('claiming returns a recovery key', typeof claim.body?.recoveryKey === 'string' && claim.body.recoveryKey.length > 10);

    const login = await req('POST', '/admin/login', { email: EMAIL, password: PASSWORD });
    check('sign in succeeds', login.status === 200, `status ${login.status}`);
    token = login.body?.token ?? '';
    check('a session token was issued', token.length > 20);

    // Every dashboard read. These are the aggregates S2.1 wrote SQLite twins for — here they run
    // through the real routes, on a real file, rather than through the parity harness.
    for (const path of [
      '/admin/health/overview', '/admin/analytics/overview', '/admin/analytics/timeseries/models',
      '/admin/analytics/timeseries/teams', '/admin/usage', '/admin/usage/by-day', '/admin/usage/by-team-key',
      '/admin/overview', '/admin/status', '/admin/notifications', '/admin/nexus/overview', '/admin/teams',
      '/admin/cache/stats', '/admin/audit', '/admin/users', '/admin/me/sessions', '/admin/settings', '/admin/config',
    ]) {
      const r = await req('GET', path);
      check(`GET ${path}`, r.status === 200, r.status === 200 ? '' : `status ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
    }

    // The Health payload, over the wire — S2.3's work as a consumer actually receives it.
    const ov = await req('GET', '/admin/health/overview');
    const b = ov.body?.backend, st = ov.body?.postgres?.stats;
    check('it reports SQLite + in-process memory', b?.db === 'sqlite' && b?.kv === 'memory', JSON.stringify(b));
    check('the labels are the human ones', b?.dbLabel === 'SQLite' && b?.kvLabel === 'In-process memory');
    check('it admits it is not durable', b?.durable === false && typeof b?.warning === 'string');
    check('the SQLite version is real', typeof st?.version === 'string' && st.version.startsWith('3.'), st?.version);
    check('the database size is real', typeof st?.databaseBytes === 'number' && st.databaseBytes > 0, String(st?.databaseBytes));
    check('the journal mode is reported', typeof st?.journalMode === 'string', st?.journalMode);
    check('the largest tables are listed', Array.isArray(st?.largestTables) && st.largestTables.length > 0);
    // Null, never 0: a file has no connection pool, and 0 would be a lie rather than an absence.
    check('connection stats are null, not zero', st?.connections === null && st?.maxConnections === null);

    // A write, then a read back — the round trip a mock cannot vouch for.
    const team = await req('POST', '/admin/teams', { name: 'Smoke Team', budgetUsd: 25, budgetPeriod: 'monthly' });
    check('create a team', team.status === 200 || team.status === 201, `status ${team.status}`);
    const teams = await req('GET', '/admin/teams');
    const list = Array.isArray(teams.body) ? teams.body : teams.body?.teams ?? [];
    check('the team reads back', list.some((t: { name: string }) => t.name === 'Smoke Team'));

    // The buffered audit writer, which on SQLite runs the createMany fallback from S2.2.
    await new Promise((r) => setTimeout(r, 3500));
    const audit = await req('GET', '/admin/audit');
    const entries = audit.body?.entries ?? audit.body ?? [];
    check('audit entries were flushed to SQLite', Array.isArray(entries) && entries.length > 0, `${entries.length} entries`);

    const out = await req('POST', '/admin/logout');
    check('sign out succeeds', out.status === 200, `status ${out.status}`);
    const after = await req('GET', '/admin/users');
    check('the session is genuinely dead', after.status === 401, `status ${after.status}`);
  } catch (e) {
    failures++;
    console.error(`\n FAIL  ${(e as Error).message}`);
  } finally {
    cleanup();
  }

  console.log(`\n${failures === 0 ? '✔ standalone mode works end to end' : `✖ ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
