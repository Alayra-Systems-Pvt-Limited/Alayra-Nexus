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
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { secretDir, writeSecretFile } from './secretFile';

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

  it('falls back to the CLI data directory when nothing is configured', () => {
    // Same place the CLI keeps its data on purpose: an operator should have one directory to secure,
    // not a credential filed somewhere nobody told them about.
    expect(secretDir({}, process.cwd())).toMatch(/\.alayra-nexus$/);
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
