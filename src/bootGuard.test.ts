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

// ── The server refuses to start without a valid master key (P1.1) ─────────────────────────────
// lib/encryption.ts no longer throws at import, so the refusal the open-source server always had
// now lives in bootGuard.ts, which server.ts imports before anything that can listen. The guard
// exits the process, so it is run here as a child process — importing it would end the test runner.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const TSX  = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Run bootGuard alone, in standalone mode (no storage URLs), with the given master key. */
function runGuard(masterKey: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['MASTER_ENCRYPTION_KEY', 'DATABASE_URL', 'REDIS_URL', 'NEXUS_MODE']) delete env[name];
  if (masterKey !== undefined) env.MASTER_ENCRYPTION_KEY = masterKey;
  const r = spawnSync(process.execPath, [TSX, join(ROOT, 'src', 'bootGuard.ts')], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('bootGuard: the master key', { timeout: 90_000 }, () => {
  it('refuses to start without MASTER_ENCRYPTION_KEY, and says what to do', () => {
    const r = runGuard(undefined);
    expect(r.status).toBe(1);
    expect(r.out).toContain('MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
    expect(r.out).toContain('randomBytes(32)');
  });

  it('refuses a key of the wrong length', () => {
    const r = runGuard('ab'.repeat(16));
    expect(r.status).toBe(1);
    expect(r.out).toContain('MASTER_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('passes with a 64-hex key', () => {
    const r = runGuard('cd'.repeat(32));
    expect(r.out).not.toContain('MASTER_ENCRYPTION_KEY');
    expect(r.status).toBe(0);
  });
});
