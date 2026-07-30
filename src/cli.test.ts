/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  parseArgs, assembleEnv, collidingNamesIn, parseEnvFile, pidAlive,
  DATA_DIR_NAME, DEFAULT_HOST, DEFAULT_PORT,
} from './cli';

const HOME = join('/tmp', 'home');
const CWD  = join('/tmp', 'project');
const env  = (o: Record<string, string | undefined> = {}) => o as NodeJS.ProcessEnv;

const parse = (argv: string[], e = env()) => parseArgs(argv, e, HOME, CWD);
const ok = (argv: string[], e = env()) => {
  const r = parse(argv, e);
  expect(r.error, `unexpected error: ${r.error}`).toBeUndefined();
  return r.options!;
};

describe('parseArgs — defaults', () => {
  it('lands in the home directory, on loopback, on 3000', () => {
    expect(ok([])).toMatchObject({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      dataDir: join(HOME, DATA_DIR_NAME),
      envFile: null,
    });
  });

  // The whole reason this launcher exists. A gateway that binds every interface because nobody
  // said otherwise, holding a password it generated itself, is a different product.
  it('does not bind every interface by default', () => {
    expect(ok([]).host).toBe('127.0.0.1');
  });

  it('never writes into the directory it was launched in', () => {
    expect(ok([]).dataDir.startsWith(HOME)).toBe(true);
  });
});

describe('parseArgs — flags', () => {
  it('takes a port', () => {
    expect(ok(['--port', '4000']).port).toBe(4000);
    expect(ok(['-p', '4000']).port).toBe(4000);
  });

  it.each([
    ['0',        'zero would ask the OS to choose, and the banner would print the wrong URL'],
    ['65536',    'out of range'],
    ['-1',       'read as a missing value, since it looks like a flag'],
    ['3000abc',  'not a number'],
    ['3.5',      'not a whole number'],
  ])('refuses --port %s (%s)', (value) => {
    expect(parse(['--port', value]).error).toBeTruthy();
  });

  it('refuses a flag with no value rather than swallowing the next flag', () => {
    expect(parse(['--port', '--host']).error).toMatch(/needs a port/);
    expect(parse(['--data-dir']).error).toMatch(/needs a path/);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // `--pot 3001` must not start a gateway on 3000 and call that success.
    expect(parse(['--pot', '3001']).error).toMatch(/Unknown option/);
  });

  it('resolves a relative --data-dir against the working directory', () => {
    expect(ok(['--data-dir', './data']).dataDir).toBe(resolve(CWD, './data'));
  });

  it('keeps an absolute --data-dir absolute', () => {
    expect(isAbsolute(ok(['--data-dir', join('/srv', 'nexus')]).dataDir)).toBe(true);
  });

  // The banner prints the data directory on one line and a file inside it on the next. Passing an
  // absolute path through untouched produced `C:/Users/…/data` above `C:\Users\…\data\secret.key`,
  // which reads like two different places.
  it('normalises separators so the banner cannot show two styles at once', () => {
    const got = ok(['--data-dir', '/srv/nexus/data']).dataDir;
    expect(got).toBe(resolve(CWD, '/srv/nexus/data'));
    if (process.platform === 'win32') expect(got).not.toContain('/');
  });

  it('resolves --env-file the same way', () => {
    expect(ok(['--env-file', '.env']).envFile).toBe(resolve(CWD, '.env'));
  });

  it('reads NEXUS_DATA_DIR, and a flag still beats it', () => {
    expect(ok([], env({ NEXUS_DATA_DIR: '/srv/a' })).dataDir).toBe(resolve(CWD, '/srv/a'));
    expect(ok(['--data-dir', '/srv/b'], env({ NEXUS_DATA_DIR: '/srv/a' })).dataDir).toBe(resolve(CWD, '/srv/b'));
  });

  it('takes --help and --version', () => {
    expect(ok(['--help']).help).toBe(true);
    expect(ok(['-v']).version).toBe(true);
  });
});

describe('assembleEnv — what the gateway is allowed to see', () => {
  const options = { port: 3001, host: '127.0.0.1', dataDir: '/srv/n', envFile: null, help: false, version: false };
  const secrets = { masterKey: 'a'.repeat(64), adminPassword: 'generated-pw' };

  it('pins both storage URLs so nothing can set them later', () => {
    const e = assembleEnv(options, env({}), secrets);
    expect(e.DATABASE_URL).toBe('');
    expect(e.REDIS_URL).toBe('');
  });

  it('applies its own port, host and data directory', () => {
    const e = assembleEnv(options, env({}), secrets);
    expect(e).toMatchObject({ PORT: '3001', HOST: '127.0.0.1', NEXUS_DATA_DIR: '/srv/n' });
  });

  it('supplies the generated secrets only when the environment has none', () => {
    const fresh = assembleEnv(options, env({}), secrets);
    expect(fresh.MASTER_ENCRYPTION_KEY).toBe('a'.repeat(64));
    expect(fresh.ADMIN_PASSWORD).toBe('generated-pw');

    const supplied = assembleEnv(options, env({ ADMIN_PASSWORD: 'mine' }), secrets);
    expect(supplied.ADMIN_PASSWORD).toBe('mine');
  });

  // The point of --env-file: a file the user NAMED is configuration, and naming it is consent.
  it('lets a named env file supply a real DATABASE_URL', () => {
    const e = assembleEnv(options, env({}), secrets, { DATABASE_URL: 'postgresql://h/db' });
    expect(e.DATABASE_URL).toBe('postgresql://h/db');
  });

  it('still lets the real environment beat the named file', () => {
    const e = assembleEnv(options, env({ DATABASE_URL: 'postgresql://real/db' }), secrets,
      { DATABASE_URL: 'postgresql://file/db' });
    expect(e.DATABASE_URL).toBe('postgresql://real/db');
  });

  it('pins only what is still missing after the file was read', () => {
    const e = assembleEnv(options, env({}), secrets, { REDIS_URL: 'redis://h:6379' });
    expect(e.REDIS_URL).toBe('redis://h:6379');
    expect(e.DATABASE_URL).toBe('');
  });
});

describe('collidingNamesIn — what the warning is allowed to claim', () => {
  it('finds the names that would have been adopted', () => {
    const found = collidingNamesIn('DATABASE_URL=postgres://x\nADMIN_PASSWORD=hunter2\n');
    expect(found.sort()).toEqual(['ADMIN_PASSWORD', 'DATABASE_URL']);
  });

  it('ignores names Nexus does not read', () => {
    expect(collidingNamesIn('STRIPE_KEY=sk_live_x\nAWS_REGION=eu-west-1\n')).toEqual([]);
  });

  it('handles the export prefix and leading whitespace', () => {
    expect(collidingNamesIn('  export PORT=8080\n')).toEqual(['PORT']);
  });

  it('does not match a name that merely appears in a value', () => {
    expect(collidingNamesIn('NOTE=we set DATABASE_URL elsewhere\n')).toEqual([]);
  });
});

describe('parseEnvFile', () => {
  it('reads plain assignments', () => {
    expect(parseEnvFile('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('strips matching quotes', () => {
    expect(parseEnvFile(`A="x y"\nB='z'\n`)).toEqual({ A: 'x y', B: 'z' });
  });

  it('ignores comment lines and trailing comments', () => {
    expect(parseEnvFile('# nope\nA=1 # trailing\n')).toEqual({ A: '1' });
  });

  it('keeps a # that is inside quotes', () => {
    expect(parseEnvFile('A="pa#ss"\n')).toEqual({ A: 'pa#ss' });
  });

  it('survives blank lines and junk', () => {
    expect(parseEnvFile('\n\nnot a line\nA=1\n')).toEqual({ A: '1' });
  });
});

describe('pidAlive — so a stale lock does not brick the data directory', () => {
  it('is true for a living process', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('is false when the process is gone', () => {
    expect(pidAlive(4242, () => { const e = new Error('no') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; })).toBe(false);
  });

  it('is true when the process exists but belongs to someone else', () => {
    // EPERM means "it is there, and not yours" — obeying the lock is right, taking it over is not.
    expect(pidAlive(4242, () => { const e = new Error('no') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; })).toBe(true);
  });

  it.each([0, -1, 1.5, NaN])('rejects %s as a pid', (pid) => {
    expect(pidAlive(pid)).toBe(false);
  });
});

// The launcher's entire purpose is to set up an environment BEFORE the server reads one. A static
// import of ./server would be hoisted above every statement in main(), whatever line it sat on —
// so the require has to stay a call, and nothing else may pull the server in ahead of it.
describe('the launcher does not load the server until it is ready', () => {
  const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

  it('never imports ./server statically', () => {
    expect(source).not.toMatch(/^\s*import\s+[^\n]*['"]\.\/server['"]/m);
  });

  it('loads it with a call, at the end of main', () => {
    // The STATEMENT, not the first mention. A plain indexOf matched the prose in a doc comment
    // explaining why the require is late — so the guard was measuring a sentence rather than code,
    // and would have gone green with the real call moved anywhere at all.
    const statement = /^\s*require\('\.\/server'\);/m.exec(source);
    const call = statement ? statement.index : -1;
    expect(call, 'cli.ts must require ./server as a top-level statement in main').toBeGreaterThan(-1);
    // After the environment is assembled, not before.
    expect(source.indexOf('assembleEnv(o,')).toBeLessThan(call);
    expect(source.indexOf('DOTENV_CONFIG_PATH')).toBeLessThan(call);
  });

  it('imports nothing that reaches the database or the gateway', () => {
    const specifiers = [...source.matchAll(/^\s*import[^\n]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    // node: builtins only. Anything else could reach @prisma/client, which reads an env file the
    // moment it is imported — the exact failure lib/mode.ts's pin exists to prevent.
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });
});

describe('assembleEnv — the terminal the gateway is running in', () => {
  const options = { port: 3001, host: '127.0.0.1', dataDir: '/srv/n', envFile: null, help: false, version: false };
  const secrets = { masterKey: 'a'.repeat(64), adminPassword: 'pw' };

  // The readiness poll at the end of startup is itself a request, so it logged two JSON lines
  // immediately before the line meant to close the output cleanly.
  it('defaults to a quiet log, so the banner is not buried in request JSON', () => {
    expect(assembleEnv(options, env({}), secrets).LOG_LEVEL).toBe('warn');
  });

  it('never overrides a log level someone asked for', () => {
    expect(assembleEnv(options, env({ LOG_LEVEL: 'debug' }), secrets).LOG_LEVEL).toBe('debug');
  });
});
