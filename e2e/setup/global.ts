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

// Global setup: build, reset, boot, wait. Returns the teardown that kills what it started.
//
// The order is the argument. The server under test is the COMPILED server — the artifact a
// deployment runs — so both packages are built first, every time, unless CI says it already
// did. Reusing a stale build is exactly the trap this repo has already fallen into once (a
// published image masquerading as the working tree, see nexus-ui-plan.md P7.13a-fix); an
// always-fresh build costs seconds and removes the whole class.
//
// Each stack's database is reset with `prisma migrate reset` — which also PROVES, on every
// single run, that a fresh install's fifteen migrations apply cleanly to an empty database.
// That is not incidental: it is one of the things this phase exists to keep true.

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  REPO_ROOT, STACKS, gatewayEnv, MOCK_PROVIDER_PORT, MOCK_PROVIDER_URL,
} from './stacks';

const children: ChildProcess[] = [];
let tearingDown = false;

function run(command: string, env: NodeJS.ProcessEnv, label: string): void {
  console.log(`[e2e setup] ${label}`);
  execSync(command, { cwd: REPO_ROOT, env, stdio: 'inherit' });
}

/** Spawn a long-lived process; keep its output so a boot failure is diagnosable. */
function launch(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): ChildProcess {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let tail = '';
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code) => {
    // A gateway that dies mid-suite should fail loudly with its last words, not as a
    // hundred opaque ECONNREFUSED test failures. The teardown's own forced kill is not
    // a death worth reporting.
    if (!tearingDown && code !== null && code !== 0) {
      console.error(`[e2e] ${label} exited with code ${code}. Last output:\n${tail}`);
    }
  });
  children.push(child);
  return child;
}

async function waitForHealth(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[e2e] ${label} did not become healthy at ${url}/health within ${timeoutMs / 1000}s`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. Fresh artifacts — the thing a deployment actually runs.
  if (!process.env.E2E_SKIP_BUILD) {
    run('npm run build', process.env, 'building gateway (tsc)');
    run('npm --prefix web run build', process.env, 'building dashboard (vite)');
  }

  // 2. Fresh state per stack: empty database, all migrations applied, empty Redis DB.
  for (const s of STACKS) {
    run(
      'npx prisma migrate reset --force --skip-generate --skip-seed',
      { ...process.env, DATABASE_URL: s.databaseUrl },
      `resetting ${s.name} database (${s.databaseUrl.split('/').pop()})`,
    );
    run(
      `npx tsx scripts/e2eFlushRedis.ts`,
      { ...process.env, REDIS_URL: s.redisUrl },
      `flushing ${s.name} redis (${s.redisUrl})`,
    );
  }

  // 3. The upstream stand-in, then the gateways — each a real process on a real socket.
  launch('node', [path.join('e2e', 'setup', 'mock-provider.mjs')],
    { ...process.env, PORT: String(MOCK_PROVIDER_PORT) }, 'mock provider');

  for (const s of STACKS) {
    launch('node', [path.join('dist', 'server.js')], gatewayEnv(s), `gateway (${s.name})`);
  }

  await waitForHealth(MOCK_PROVIDER_URL, 'mock provider');
  for (const s of STACKS) {
    await waitForHealth(s.baseURL, `gateway (${s.name})`);
  }
  console.log('[e2e setup] both gateways and the mock provider are healthy');

  return async () => {
    tearingDown = true;
    for (const child of children) {
      if (child.pid && !child.killed) {
        // On Windows a detached-ish shell-spawned tree needs taskkill to take the whole tree down.
        if (process.platform === 'win32') {
          try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
        } else {
          child.kill('SIGTERM');
        }
      }
    }
  };
}
