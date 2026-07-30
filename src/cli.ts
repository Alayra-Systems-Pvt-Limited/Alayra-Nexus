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

// `npx alayra-nexus` — the launcher, and only the launcher (Phase S4).
//
// This starts a gateway. It is NOT a CLI: there are no subcommands for pools, keys, models or
// analytics, because all of that already exists in the dashboard this same process serves. A real
// CLI is a separate phase and a thin wrapper over the admin API.
//
// ── The rule this file exists to enforce ──────────────────────────────────────────────────────
// A gateway launched by `npx` inherits NOTHING from the directory it was launched in.
//
// `.env` belongs to the project sitting in that directory, and Nexus is not that project. The tools
// that legitimately read `./.env` — Vite, Next, Prisma — are all operating ON your project, so the
// file is theirs. A gateway is a separate server that happens to share your terminal.
//
// This is not a rule about DATABASE_URL. Ten of the variables the gateway reads have names that are
// perfectly ordinary in somebody else's .env — PORT, HOST, NODE_ENV, LOG_LEVEL, PUBLIC_URL,
// METRICS_TOKEN, and ADMIN_PASSWORD, which is the frightening one: it would silently become the
// owner credential, and it is also the second proof required to authorise a destructive restore. A
// policy that blocked two names and allowed the other eight would not be a policy.
//
// The source checkout and the Compose deployment are UNCHANGED: there, `./.env` really is the
// gateway's own configuration file, and every existing install depends on that. The difference is
// not an inconsistency, it is a consequence of who owns the directory.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';

/** Where the gateway keeps its database, its key and its lock, unless told otherwise. */
export const DATA_DIR_NAME = '.alayra-nexus';
export const KEY_FILE      = 'secret.key';
export const PASSWORD_FILE = 'admin-password';
export const LOCK_FILE     = 'nexus.lock';

export const DEFAULT_PORT = 3000;

/**
 * Loopback, not 0.0.0.0 — which is what the server itself still defaults to.
 *
 * A gateway started by one command, holding a password this launcher generated, must not be on the
 * network because nobody said otherwise. `--host 0.0.0.0` is one flag away for anyone who means it.
 */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Variables the gateway reads whose names are common enough to appear in an unrelated project.
 *
 * Only used to WARN. Nothing here is ever read from a `.env` the user did not name.
 */
export const COLLIDING_NAMES = [
  'DATABASE_URL', 'REDIS_URL', 'ADMIN_PASSWORD', 'MASTER_ENCRYPTION_KEY',
  'PORT', 'HOST', 'NODE_ENV', 'LOG_LEVEL', 'PUBLIC_URL', 'METRICS_TOKEN',
] as const;

export interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  envFile: string | null;
  help: boolean;
  version: boolean;
}

export interface ParseResult {
  options?: CliOptions;
  error?: string;
}

/**
 * Flags only — no positional arguments, since there are no subcommands to name.
 *
 * `homeDir` and `cwd` are injected so the whole of this is testable without touching the real
 * filesystem or the real home directory.
 */
export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
): ParseResult {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    dataDir: join(homeDir, DATA_DIR_NAME),
    envFile: null,
    help: false,
    version: false,
  };

  // NEXUS_DATA_DIR is honoured because it is ours and explicit. A relative one resolves against the
  // working directory, which is the only thing about that directory this launcher will use.
  // `resolve` rather than `isAbsolute ? raw : join(...)`: it handles an absolute path correctly on
  // its own AND normalises separators, so a `--data-dir /tmp/x` on Windows does not produce a
  // banner that prints one path with forward slashes and the file beside it with backslashes.
  const fromEnv = env.NEXUS_DATA_DIR?.trim();
  if (fromEnv) options.dataDir = resolve(cwd, fromEnv);

  const needsValue = (flag: string, value: string | undefined): string | null => {
    if (value === undefined || value.startsWith('-')) return null;
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help':    options.help = true; break;
      case '-v': case '--version': options.version = true; break;

      case '-p': case '--port': {
        const raw = needsValue(arg, argv[++i]);
        if (raw === null) return { error: `${arg} needs a port number, for example --port 3001.` };
        const port = Number(raw);
        // A port must be a whole number in range. `Number('3000abc')` is NaN, and 0 would ask the
        // OS to pick one — which would print a URL that is not where the gateway is listening.
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { error: `"${raw}" is not a port number between 1 and 65535.` };
        }
        options.port = port;
        break;
      }

      case '--host': {
        const raw = needsValue(arg, argv[++i]);
        if (raw === null) return { error: '--host needs an address, for example --host 0.0.0.0.' };
        options.host = raw;
        break;
      }

      case '--data-dir': {
        const raw = needsValue(arg, argv[++i]);
        if (raw === null) return { error: '--data-dir needs a path.' };
        options.dataDir = resolve(cwd, raw);
        break;
      }

      case '--env-file': {
        const raw = needsValue(arg, argv[++i]);
        if (raw === null) return { error: '--env-file needs a path to a file.' };
        options.envFile = resolve(cwd, raw);
        break;
      }

      default:
        // Never ignore an unknown flag. Silently dropping `--pot 3001` would start a gateway on the
        // wrong port and report success.
        return { error: `Unknown option "${arg}". Run \`alayra-nexus --help\` for the list.` };
    }
  }

  return { options };
}

/**
 * The environment the gateway will see, built from scratch rather than inherited from a directory.
 *
 * Order matters and is the point:
 *   1. the real process environment — someone typed it, or their orchestrator set it;
 *   2. an `--env-file`, if one was NAMED;
 *   3. this launcher's own settings;
 *   4. the storage pin, which fills only what is still absent.
 *
 * Step 4 last is what lets `--env-file ./.env` supply a real DATABASE_URL: the user asked for that
 * file by name, so it wins. Everything the user did not ask for stays empty, and empty is a value
 * no later `.env` load will overwrite — see `pinStorageEnv` in lib/mode.ts.
 */
export function assembleEnv(
  options: CliOptions,
  base: NodeJS.ProcessEnv,
  secrets: { masterKey: string; adminPassword: string },
  fileValues: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  for (const [k, v] of Object.entries(fileValues)) {
    if (env[k] === undefined) env[k] = v;
  }

  env.NEXUS_DATA_DIR         = options.dataDir;
  env.PORT                   = String(options.port);
  env.HOST                   = options.host;
  env.MASTER_ENCRYPTION_KEY  = env.MASTER_ENCRYPTION_KEY  || secrets.masterKey;
  env.ADMIN_PASSWORD         = env.ADMIN_PASSWORD         || secrets.adminPassword;

  // Quiet by default, and only here — a server-mode deployment keeps whatever it already had.
  // This gateway is running in somebody's terminal, in front of them, where per-request JSON is
  // noise laid over the one screen of output that actually tells them what to do next. Setting
  // LOG_LEVEL explicitly still wins, so nothing is hidden from anyone who asks for it.
  env.LOG_LEVEL = env.LOG_LEVEL || 'warn';

  if (env.DATABASE_URL === undefined) env.DATABASE_URL = '';
  if (env.REDIS_URL    === undefined) env.REDIS_URL    = '';

  return env;
}

/** Names from `COLLIDING_NAMES` that appear as assignments in a `.env` body. */
export function collidingNamesIn(body: string): string[] {
  const found = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m && (COLLIDING_NAMES as readonly string[]).includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** Minimal `KEY=value` reader for a file the user named. Quotes stripped, `#` comments ignored. */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('#')) value = '';
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.split(' #')[0].trim();
    out[m[1]] = value;
  }
  return out;
}

/** A lock's contents. The pid is what makes a stale lock recoverable rather than permanent. */
export interface LockInfo { pid: number; port: number; startedAt: string }

/** True when a process with this pid exists. Signal 0 tests for existence without delivering one. */
export function pidAlive(pid: number, kill: (p: number, s: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) {
    // EPERM means it exists and belongs to someone else — which still counts as alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── Everything below touches the filesystem, the network or the process ───────────────────────

const PKG = (): { version: string } => {
  // From `dist/cli.js` this resolves to the package root, which is where npm puts package.json in
  // an installed copy as well as in a checkout.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { return require('../package.json') as { version: string }; }
  catch { return { version: '0.0.0' }; }
};

function usage(): string {
  return `
  alayra-nexus — start an Alayra Nexus gateway

  Usage
    npx alayra-nexus [options]

  Options
    -p, --port <n>       port to listen on            (default ${DEFAULT_PORT})
        --host <addr>    address to bind              (default ${DEFAULT_HOST}, loopback only)
        --data-dir <p>   where to keep data and keys  (default ~/${DATA_DIR_NAME})
        --env-file <p>   read configuration from this file
    -h, --help           show this
    -v, --version        print the version

  Notes
    A .env in the current directory is NOT read. It belongs to the project in that
    directory, not to Nexus. Name it explicitly with --env-file to use it.

    Nothing is sent anywhere. There is no telemetry.
`;
}

/** Create the data directory, owner-only where the platform enforces that. */
function ensureDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    fail([
      `Cannot create the data directory at ${dir}`,
      `${err.code ?? 'error'}: ${err.message}`,
      '',
      'Choose somewhere writable with:  alayra-nexus --data-dir ./nexus-data',
    ]);
  }
}

/**
 * Read the master key, or generate one once and keep it.
 *
 * Generating a fresh key per run would be silent, unrecoverable data loss: everything sealed in
 * session one becomes unreadable in session two. So it is written once and never regenerated, and
 * the banner tells the operator to back the file up — because losing it has no recovery path by
 * design.
 */
function ensureMasterKey(dir: string): { key: string; created: boolean } {
  const path = join(dir, KEY_FILE);
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim();
    if (key.length !== 64 || !/^[0-9a-f]+$/i.test(key)) {
      fail([
        `The encryption key at ${path} is not 64 hexadecimal characters.`,
        '',
        'It has been damaged or truncated. Restore it from your backup — without the ORIGINAL key,',
        'the provider credentials in this gateway cannot be decrypted by anything, ever.',
      ]);
    }
    return { key, created: false };
  }
  const key = randomBytes(32).toString('hex');
  writeSecret(path, `${key}\n`);
  return { key, created: true };
}

/**
 * The owner password, generated rather than defaulted.
 *
 * Kept on disk because it is not a one-time token: it is checked again for every destructive
 * restore, against the server's own environment rather than a session. A password only shown once
 * would make that check unpassable a week later.
 */
function ensureAdminPassword(dir: string): { password: string; created: boolean } {
  const path = join(dir, PASSWORD_FILE);
  if (existsSync(path)) {
    const password = readFileSync(path, 'utf8').trim();
    if (password) return { password, created: false };
  }
  // Base64url of 18 bytes: 24 characters, no ambiguous punctuation, ~143 bits.
  const password = randomBytes(18).toString('base64url');
  writeSecret(path, `${password}\n`);
  return { password, created: true };
}

/** Write owner-only. The chmod is separate because an existing file keeps its old mode otherwise. */
function writeSecret(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* windows does not enforce this; see the plan */ }
}

/**
 * Refuse to run a second gateway over the same data directory.
 *
 * SQLite takes one writer, and counters and sessions live in each process — so two instances on one
 * directory do not share a gateway, they disagree about one. A dead pid is taken over rather than
 * obeyed, so a killed process cannot leave the directory permanently unusable.
 */
function acquireLock(dir: string, port: number): void {
  const path = join(dir, LOCK_FILE);

  if (existsSync(path)) {
    let held: LockInfo | null = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')) as LockInfo; } catch { held = null; }

    if (held && pidAlive(held.pid)) {
      fail([
        `A gateway is already running on this data directory (pid ${held.pid}, port ${held.port}).`,
        '',
        `  data directory   ${dir}`,
        `  started          ${held.startedAt}`,
        '',
        'Two gateways cannot share one directory: SQLite takes a single writer, and each process',
        'keeps its own counters and sessions, so they would disagree about the same database.',
        '',
        'Stop it first, or start a separate gateway with its own directory:',
        '  alayra-nexus --data-dir ./another --port 3001',
      ]);
    }
  }

  const info: LockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(info, null, 2));

  // `exit` covers a clean stop, the server's own SIGINT/SIGTERM handling, and an uncaught throw.
  process.on('exit', () => { try { rmSync(path, { force: true }); } catch { /* going away anyway */ } });
}

/**
 * Bind the port here, first, and let go.
 *
 * The server exits on its own fatal errors, so once it is handed control an EADDRINUSE becomes a
 * stack trace rather than a sentence. Port 3000 is the single most contended port in local
 * development, which makes this the most likely first failure any new user will see.
 */
async function checkPortFree(port: number, host: string): Promise<void> {
  await new Promise<void>((done) => {
    const probe = createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        fail([
          `Port ${port} is already in use.`,
          '',
          `  alayra-nexus --port ${port + 1}`,
        ]);
      }
      if (e.code === 'EACCES') {
        fail([
          `Not allowed to bind port ${port}.`,
          '',
          'Ports below 1024 need elevated privileges on most systems. Pick a higher one:',
          `  alayra-nexus --port ${DEFAULT_PORT}`,
        ]);
      }
      fail([`Cannot listen on ${host}:${port}`, `${e.code ?? 'error'}: ${e.message}`]);
    });
    probe.once('listening', () => probe.close(() => done()));
    probe.listen(port, host);
  });
}

/**
 * The generated Prisma clients, which are built by this package's postinstall.
 *
 * Checked by RESOLUTION, not by loading: resolving is a filesystem lookup with no side effects,
 * where importing `@prisma/client` reads an env file. The failure this catches is an install run
 * with `--ignore-scripts`, which is common enough in locked-down environments to deserve a sentence
 * rather than a module-not-found stack.
 */
function checkClientsGenerated(): void {
  for (const specifier of ['.prisma/client', '.prisma/client-sqlite']) {
    try { require.resolve(specifier); } catch {
      fail([
        'The database client was not generated when this package was installed.',
        '',
        'That happens when installation skips lifecycle scripts (--ignore-scripts, or a policy',
        'that disables them). Reinstall allowing scripts, or generate them by hand:',
        '',
        '  npm exec --package=alayra-nexus -- prisma generate',
        '',
        `(missing: ${specifier})`,
      ]);
    }
  }
}

function fail(lines: string[]): never {
  console.error(`\n✖  ${lines[0]}`);
  for (const l of lines.slice(1)) console.error(l ? `   ${l}` : '');
  console.error('');
  process.exit(1);
}

/** The launch banner. Says where everything lives, and what happens if the key is lost. */
function banner(o: CliOptions, created: { key: boolean; password: boolean }, password: string): void {
  const v = PKG().version;
  console.log(`\n  Alayra Nexus ${v}${created.key ? ' — first run' : ''}\n`);
  console.log(`  Data directory   ${o.dataDir}`);
  console.log(`  Encryption key   ${join(o.dataDir, KEY_FILE)}${created.key ? '  (generated)' : ''}`);

  if (created.key) {
    console.log('');
    console.log('  ⚠  Back that key file up, somewhere other than this machine.');
    console.log('     Without it the provider keys stored here can never be decrypted again.');
    console.log('     There is no recovery path. That is deliberate.');
  }

  console.log('');
  if (created.password) {
    console.log(`  Admin password   ${password}`);
    console.log('                   Use it to claim the gateway in the dashboard.');
  } else {
    console.log(`  Admin password   ${join(o.dataDir, PASSWORD_FILE)}`);
  }
  console.log('');
  // Deliberately no URL and no "Ctrl-C to stop" here. The server prints the URLs itself moments
  // later, along with the table count, the API key and the storage line — so a closing line at this
  // point would be closing nothing, and the tidy block would be followed by four more paragraphs.
  // The ending belongs at the end: see `announceReady`.
}

/**
 * The last line, printed when the gateway actually answers rather than when we hoped it would.
 *
 * `require('./server')` returns as soon as the module body has run, and the server boots
 * asynchronously after that — so anything printed straight afterwards is a guess. Polling means
 * "Ready" is a fact. If it never becomes ready the loop simply ends: the server reports its own
 * fatal errors and exits, and a second opinion from here would only be noise on top of a real one.
 */
async function announceReady(o: CliOptions): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${o.host}:${o.port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        console.log(`\n  ✓  Ready — open http://${o.host}:${o.port}`);
        console.log('     Ctrl-C to stop.\n');
        return;
      }
    } catch { /* not listening yet */ }
    await new Promise((done) => setTimeout(done, 300));
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { options, error } = parseArgs(argv);
  if (error) fail([error]);
  const o = options!;

  // Both exit before anything is created, read or bound.
  if (o.help)    { console.log(usage()); return; }
  if (o.version) { console.log(PKG().version); return; }

  checkClientsGenerated();

  // Say what is being ignored. Silently adopting a stranger's .env is an incident; silently
  // ignoring one is a support ticket. Saying so is neither.
  const localEnv = resolve(process.cwd(), '.env');
  if (!o.envFile && existsSync(localEnv)) {
    const names = collidingNamesIn(readFileSync(localEnv, 'utf8'));
    if (names.length > 0) {
      console.log(`\n  Note: ./.env sets ${names.join(', ')} — not used.`);
      console.log('  A .env belongs to the project in this directory, not to Nexus.');
      console.log('  To use it deliberately:  alayra-nexus --env-file ./.env');
    }
  }

  ensureDataDir(o.dataDir);
  const { key, created: keyCreated }           = ensureMasterKey(o.dataDir);
  const { password, created: passwordCreated } = ensureAdminPassword(o.dataDir);

  let fileValues: Record<string, string> = {};
  if (o.envFile) {
    if (!existsSync(o.envFile)) fail([`No such file: ${o.envFile}`]);
    fileValues = parseEnvFile(readFileSync(o.envFile, 'utf8'));
  }

  const env = assembleEnv(o, process.env, { masterKey: key, adminPassword: password }, fileValues);
  // Skip undefined rather than assigning it: `process.env.X = undefined` stores the STRING
  // "undefined", which every `?.trim() ||` check in the codebase would read as a configured value.
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

  // The server calls `dotenv/config` at its top, which would otherwise read ./.env — the very file
  // this launcher just declined to use. Pointing dotenv at what we chose, or at a path inside the
  // data directory that need not exist (dotenv ignores a missing file), keeps that promise without
  // changing the server at all.
  process.env.DOTENV_CONFIG_PATH = o.envFile ?? join(o.dataDir, '.env');

  await checkPortFree(o.port, o.host);
  acquireLock(o.dataDir, o.port);
  banner(o, { key: keyCreated, password: passwordCreated }, password);

  // LATE, and this is load-bearing. Requiring the server at the top of this file would run
  // `dotenv/config` and the MASTER_ENCRYPTION_KEY check before a single line above had executed —
  // the same class of ordering bug as the .env injection fixed in lib/mode.ts. A static import
  // would be hoisted above everything here no matter where it sat in the file, so this has to be a
  // call rather than an import. Guarded by a test.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./server');

  await announceReady(o);
}
