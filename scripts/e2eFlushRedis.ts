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

// Flush the Redis logical DB named by REDIS_URL. Called by the e2e global setup so each
// suite run starts with no leftover rate-limit counters, sessions, or breaker state.
// Lives in the root package (not e2e/) because ioredis is a dependency here — the e2e
// package deliberately carries nothing but Playwright.
//
// Guard: refuses to flush DB 0, which is where a developer's real local gateway keeps
// its state. The e2e stacks use logical DBs 1 and 2 precisely so this can never touch it.

import Redis from 'ioredis';

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');

  const db = parseInt(new URL(url).pathname.replace('/', '') || '0', 10);
  if (db === 0) throw new Error(`refusing to flush Redis DB 0 (${url}) — that is the live gateway's database`);

  const redis = new Redis(url);
  await redis.flushdb();
  await redis.quit();
  console.log(`flushed redis db ${db}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
