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

// Postgres and Redis for a benchmark run.
//
// Shared by every scenario that measures the topology people actually deploy, rather than the
// standalone file. Two of them need it for different reasons — the scaling run because the gateway
// refuses to fork without a shared Redis, and the k6 run because a published number should describe
// a real deployment — and neither should own the containers.
//
// Ports are deliberately unusual. A developer's own Postgres on 5432 would otherwise be found, used,
// and quietly measured, which is the same class of mistake as a stray .env pointing the "standalone"
// benchmark at a real database.

import { execFileSync } from 'node:child_process';

export const PG_PORT = 55_432;
export const REDIS_PORT = 56_379;
export const PG_PASSWORD = 'benchpass';

const PG_CONTAINER = 'nexus-bench-pg';
const REDIS_CONTAINER = 'nexus-bench-redis';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function docker(args: string[], quiet = true): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' }) ?? '';
  } catch (e) {
    if (quiet) return '';
    throw e;
  }
}

export function containersUp(): void {
  console.log('bringing up postgres and redis…');
  docker(['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);

  docker(['run', '-d', '--name', PG_CONTAINER,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-p', `${PG_PORT}:5432`,
    // The benchmark writes almost nothing, and what it does write does not need to survive the
    // container. tmpfs keeps the host disk out of the measurement entirely.
    '--tmpfs', '/var/lib/postgresql/data',
    'postgres:16-alpine',
  ], false);

  docker(['run', '-d', '--name', REDIS_CONTAINER, '-p', `${REDIS_PORT}:6379`, 'redis:7-alpine'], false);
}

export function containersDown(): void {
  docker(['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
}

export async function waitForPostgres(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', PG_CONTAINER, 'pg_isready', '-U', 'postgres']).includes('accepting connections')) return;
    await sleep(500);
  }
  throw new Error('postgres never became ready');
}

export async function waitForRedis(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', REDIS_CONTAINER, 'redis-cli', 'ping']).includes('PONG')) return;
    await sleep(500);
  }
  throw new Error('redis never became ready');
}

/**
 * A database of its own, dropped first.
 *
 * Each run claims the gateway and creates a pool on first boot, and that only works against an
 * empty database. Reusing one produces a confusing "could not read the generated API key", because
 * the gateway correctly declines to generate a second.
 */
export function createDatabase(name: string): string {
  docker(['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-c', `DROP DATABASE IF EXISTS ${name}`]);
  docker(['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-c', `CREATE DATABASE ${name}`]);
  return `postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${name}`;
}

export function migrate(databaseUrl: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}

/**
 * A Redis URL on its own database index.
 *
 * Settings are cached in Redis for five minutes and the API key hash is one of them, so a second
 * run inside that window boots against the previous run's key and fails to find a new one. An index
 * per run is cheaper than flushing and cannot race a run that is still finishing.
 */
export function redisUrlFor(index: number): string {
  return `redis://127.0.0.1:${REDIS_PORT}/${(index % 15) + 1}`;
}
