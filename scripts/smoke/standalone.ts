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

  // An EMPTY working directory, and both URLs genuinely ABSENT rather than blank.
  //
  // They used to be passed as empty strings, which made this the one caller that could not catch
  // the bug it was working around: importing `@prisma/client` loads the .env beside its schema —
  // this checkout's — and sets both variables from it, whatever directory the process runs in. The
  // empty temp directory below is therefore NOT protection; only the blanking was, and that exact
  // mistake produced a passing "standalone" run during S2.0 that was really Postgres. Blanking here
  // immunised this script and left every other caller exposed, which is why the bug survived two
  // phases.
  //
  // The gateway pins them for itself now (`pinStorageEnv` in lib/mode.ts). Deleting rather than
  // blanking is what makes this the npx condition: unset, not set-to-nothing, so the gateway has to
  // do the pinning. On any machine whose checkout has a .env — every developer's, by definition —
  // that turns this script into a live regression test for it. Verified by disabling the pin and
  // running this: it dies with "Cannot reach Redis at localhost:6379 / REDIS_URL=localhost:6379",
  // a variable nothing here set. In CI, where there is no .env, it degrades to what it always was.
  const childEnv = {
    ...process.env,
    NEXUS_MODE: '',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    ADMIN_PASSWORD: MASTER,
    MASTER_ENCRYPTION_KEY: 'a'.repeat(64),
    LOG_LEVEL: 'warn',
  } as NodeJS.ProcessEnv;
  // Not `= ''`: a developer's shell often has both, and inheriting one would silently test server
  // mode while reporting a standalone pass.
  delete childEnv.DATABASE_URL;
  delete childEnv.REDIS_URL;

  const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js')], {
    cwd: dir,
    env: childEnv,
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
    // The key must NOT be in the log — that is the whole point of writing it to a file — so this
    // checks two things at once: that the gateway announced where it put the key, and that the
    // 64-hex key itself is nowhere in stdout. A regression that started printing it again would
    // pass the first check and fail the second.
    check('it wrote the API key to a file on first run', /Generated your Nexus API Key/.test(output),
      output.split('\n').find((l) => l.includes('API Key')) ?? 'no such line in the log');
    check('the key itself never reached the log', !/\b[0-9a-f]{64}\b/.test(output),
      'a 64-hex value appeared in stdout');

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
    // WAL specifically, not merely "some mode was reported" (S2.5). This is the one check that
    // proves the boot-time tuning ran against the real database rather than a test fixture — and
    // `delete` here would mean every background write is queueing behind every dashboard read.
    check('the database is in WAL mode', st?.journalMode === 'wal', String(st?.journalMode));
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

    // ── Backup and restore (B1.3), over HTTP, against the real gateway ──────────────────────────
    //
    // The parity suite proves the engine by driving two databases directly. This proves the part
    // only a running gateway can: the routes, the guards, the multipart upload and the streaming
    // download, on a gateway that built its own database minutes ago.
    const PASSPHRASE = 'a-long-enough-backup-passphrase';

    const exported = await fetch(`${BASE}/admin/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    check('export returns a file', exported.status === 200, `status ${exported.status}`);
    check('it is sent as a download', /attachment; filename=".*\.nxb"/.test(exported.headers.get('content-disposition') ?? ''),
      exported.headers.get('content-disposition') ?? 'no header');
    check('it is never cached', (exported.headers.get('cache-control') ?? '').includes('no-store'));

    const file = Buffer.from(await exported.arrayBuffer());
    check('the file has content', file.length > 200, `${file.length} bytes`);

    // The header is plaintext by necessity; everything after it must not be.
    const headerLine = file.subarray(0, file.indexOf(0x0a)).toString('utf8');
    check('it opens with a readable header', headerLine.includes('alayra-nexus-backup'), headerLine.slice(0, 60));
    check('the body is encrypted', !file.subarray(file.indexOf(0x0a)).toString('binary').includes('Smoke Team'));

    /** Upload the file back, as a browser would. */
    const restore = async (fields: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(file)]), 'backup.nxb');
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const r = await fetch(`${BASE}/admin/backup/restore`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
      });
      return { status: r.status, body: await r.json().catch(() => null) as any };  // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const dry = await restore({ passphrase: PASSPHRASE, mode: 'merge', dryRun: 'true' });
    check('a dry run reports the plan', dry.status === 200, `status ${dry.status} ${JSON.stringify(dry.body).slice(0, 140)}`);
    check('the plan counts the rows in the file', (dry.body?.totalRowsInFile ?? 0) > 0, `${dry.body?.totalRowsInFile} rows`);
    check('a dry run writes nothing', dry.body?.totalWritten === 0);

    const merged = await restore({ passphrase: PASSPHRASE, mode: 'merge', dryRun: 'false' });
    check('a merge restore succeeds', merged.status === 200, `status ${merged.status}`);
    // Every row is already present, so a merge of a gateway's own backup is a no-op — which is the
    // cleanest possible demonstration that merge does not duplicate or overwrite.
    check('restoring its own backup changes nothing', merged.body?.totalWritten === 0, `wrote ${merged.body?.totalWritten}`);

    const wrong = await restore({ passphrase: 'the-wrong-passphrase-here', mode: 'merge', dryRun: 'true' });
    check('a wrong passphrase is refused', wrong.status === 400, `status ${wrong.status}`);
    check('and it says nothing was changed', /nothing was changed/i.test(wrong.body?.hint ?? ''), wrong.body?.hint ?? '');

    // Wrapped for the gateway as well (B1.2b): the same file opens with no passphrase at all, which
    // is what lets a scheduled job restore unattended — while the passphrase still works, so the
    // backup survives the machine.
    const dual = await fetch(`${BASE}/admin/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ passphrase: PASSPHRASE, includeGatewayRecipient: true }),
    });
    check('export accepts a gateway recipient', dual.status === 200, `status ${dual.status}`);
    const dualFile = Buffer.from(await dual.arrayBuffer());

    const asGateway = async (fields: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(dualFile)]), 'backup.nxb');
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const r = await fetch(`${BASE}/admin/backup/restore`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
      });
      return { status: r.status, body: await r.json().catch(() => null) as any };  // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const noPass = await asGateway({ mode: 'merge', dryRun: 'true' });
    check('it opens with no passphrase, using the gateway key', noPass.status === 200,
      `status ${noPass.status} ${JSON.stringify(noPass.body).slice(0, 120)}`);
    check('and still reports the same contents', (noPass.body?.totalRowsInFile ?? 0) > 0, `${noPass.body?.totalRowsInFile} rows`);

    const stillPass = await asGateway({ passphrase: PASSPHRASE, mode: 'merge', dryRun: 'true' });
    check('the passphrase still opens it too', stillPass.status === 200, `status ${stillPass.status}`);

    // And the ordinary download must NOT be openable that way — it left the building.
    const noPassOnPlain = await restore({ mode: 'merge', dryRun: 'true' });
    check('a passphrase-only backup is not openable by the gateway', noPassOnPlain.status === 400,
      `status ${noPassOnPlain.status}`);

    const unconfirmed = await restore({ passphrase: PASSPHRASE, mode: 'replace', dryRun: 'false' });
    check('a replace without the typed phrase is refused', unconfirmed.status === 400, `status ${unconfirmed.status}`);

    const unauthorised = await restore({ passphrase: PASSPHRASE, mode: 'replace', dryRun: 'false', confirm: 'REPLACE ALL DATA' });
    check('a replace without the master password is refused', unauthorised.status === 401, `status ${unauthorised.status}`);

    const out = await req('POST', '/admin/logout');
    check('sign out succeeds', out.status === 200, `status ${out.status}`);
    check('export needs a session', (await fetch(`${BASE}/admin/backup/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASSPHRASE }),
    })).status === 401);
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
