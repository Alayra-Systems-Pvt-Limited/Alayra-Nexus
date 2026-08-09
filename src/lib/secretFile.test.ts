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

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { secretDir, writeSecretFile } from './secretFile';
import { DEFAULT_DATA_DIR, resolveDatabaseUrl } from './mode';

const made: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-secret-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.NEXUS_DATA_DIR;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('secretDir', () => {
  it('honours NEXUS_DATA_DIR', () => {
    const dir = scratch();
    expect(secretDir({ NEXUS_DATA_DIR: dir }, process.cwd())).toBe(resolve(dir));
  });

  it('resolves a relative NEXUS_DATA_DIR against the working directory, not the process root', () => {
    expect(secretDir({ NEXUS_DATA_DIR: 'data' }, '/srv/nexus')).toBe(resolve('/srv/nexus', 'data'));
  });

  // The assertion that used to live here required `~/.alayra-nexus` and so locked in the bug below,
  // passing on every run while the container it describes could not start.
  it('falls back to the SAME directory the database uses', () => {
    // One idea, one default. The whole point of writing the key to a file is that an operator has
    // one directory to secure; two defaults for that directory defeats it before anything else.
    const cwd = '/srv/nexus';
    expect(secretDir({}, cwd)).toBe(resolve(cwd, DEFAULT_DATA_DIR));
  });

  it('agrees with resolveDatabaseUrl about where the data directory is', () => {
    // Stated as agreement between the two functions rather than as a literal, so this keeps holding
    // if the default is ever changed in one place — which is exactly how they drifted apart.
    for (const env of [{}, { NEXUS_DATA_DIR: 'data' }, { NEXUS_DATA_DIR: '/var/lib/nexus' }]) {
      const cwd = '/srv/nexus';
      const dbFile = resolveDatabaseUrl(env, cwd).replace(/^file:/, '');
      expect(dirname(dbFile)).toBe(secretDir(env, cwd));
    }
  });

  it('never escapes the working directory when the process has no real home', () => {
    // The container case, and the one that failed a release. `--user "$(id -u):$(id -g)"` — the
    // recipe the README documents for a bind mount — gives the process a uid with no passwd entry,
    // so homedir() is `/`. The old fallback then aimed at `/.alayra-nexus`, which an unprivileged
    // user cannot create: EACCES, at first boot, after the database had already been built.
    const dir = secretDir({}, '/app');
    expect(dir.startsWith(resolve('/app'))).toBe(true);
    expect(dir).not.toBe(resolve('/'));
  });
});

describe('writeSecretFile', () => {
  it('writes the secret and returns the path to it', () => {
    process.env.NEXUS_DATA_DIR = scratch();
    const path = writeSecretFile('api-key.txt', 'super-secret-value');
    expect(readFileSync(path, 'utf8').trim()).toBe('super-secret-value');
  });

  it('creates the directory when it does not exist yet', () => {
    // First run has no data directory. A crash here would take the boot down with it.
    process.env.NEXUS_DATA_DIR = join(scratch(), 'nested', 'deeper');
    const path = writeSecretFile('api-key.txt', 'k');
    expect(readFileSync(path, 'utf8').trim()).toBe('k');
  });

  it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
    process.env.NEXUS_DATA_DIR = scratch();
    const path = writeSecretFile('api-key.txt', 'k');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens the mode on a file that already existed', () => {
    // The mode argument to writeFileSync only applies when the file is CREATED. Without the explicit
    // chmod, overwriting a world-readable leftover would keep it world-readable — the exact case
    // where the permissions matter most.
    const dir = scratch();
    process.env.NEXUS_DATA_DIR = dir;
    const path = join(dir, 'api-key.txt');
    writeFileSync(path, 'old', { mode: 0o644 });

    writeSecretFile('api-key.txt', 'new');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
