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
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';

// The launcher points the server's `dotenv/config` at the env file it chose. dotenv 18 reads
// DOTENV_PATH and DOTENV_OVERRIDE ahead of DOTENV_CONFIG_PATH and DOTENV_CONFIG_OVERRIDE, so setting
// only the older names would let a value left in the operator's shell load a file nobody named, or
// let that file outrank the environment the launcher assembled.
const NAMES = ['DOTENV_PATH', 'DOTENV_CONFIG_PATH', 'DOTENV_OVERRIDE', 'DOTENV_CONFIG_OVERRIDE'];

describe('the launcher sets every name dotenv reads before it loads the server', () => {
  const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

  it('assigns all four, ahead of the require', () => {
    // Assignments, not mentions: prose about a name in a comment must not satisfy this.
    const call = /^\s*require\('\.\/server'\);/m.exec(source)?.index ?? -1;
    expect(call, 'cli.ts must require ./server as a top-level statement in main').toBeGreaterThan(-1);
    for (const name of NAMES) {
      const set = new RegExp(`process\\.env\\.${name}\\s*=(?!=)`).exec(source);
      expect(set, `cli.ts must assign ${name}`).not.toBeNull();
      expect(set!.index, `${name} must be set before ./server is required`).toBeLessThan(call);
    }
  });
});

// Against the real dotenv, because the fix above rests on a claim about it. If a later dotenv
// changed which names it reads first, this is the test that would say so.
describe('dotenv reads the newer names first', () => {
  it('loads DOTENV_PATH over DOTENV_CONFIG_PATH, and DOTENV_OVERRIDE=false keeps what is set', () => {
    const dir    = mkdtempSync(join(tmpdir(), 'nexus-dotenv-'));
    const chosen = join(dir, 'chosen.env');
    const other  = join(dir, 'other.env');
    writeFileSync(chosen, 'NEXUS_DOTENV_PICKED=chosen\nPORT=9999\n');
    writeFileSync(other,  'NEXUS_DOTENV_PICKED=other\n');

    const saved = NAMES.map((name) => [name, process.env[name]] as const);
    try {
      process.env.DOTENV_PATH            = chosen;
      process.env.DOTENV_CONFIG_PATH     = other;
      process.env.DOTENV_OVERRIDE        = 'false';
      process.env.DOTENV_CONFIG_OVERRIDE = 'true';
      const e: NodeJS.ProcessEnv = { PORT: '3000' };
      dotenv.config({ processEnv: e, quiet: true });
      expect(e.NEXUS_DOTENV_PICKED).toBe('chosen');
      expect(e.PORT).toBe('3000');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
