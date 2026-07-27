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

import { prisma } from '../lib/prisma';
import { redis, suppressRedisErrorLog } from '../lib/redis';
import { formatStartupFailure } from '../lib/startup';
import { resolveDatabaseUrl } from '../lib/mode';

/** Thrown when a hard dependency is unreachable. Carries a printable message only. */
export class StartupCheckError extends Error {}

/**
 * Verify both hard dependencies before the server does any real work.
 *
 * Failing here rather than on the first request is deliberate: an orchestrator should
 * restart a gateway that cannot reach Redis, and a developer should be told which
 * service to start. Both checks run against the same clients the app uses, so a pass
 * here means the app's own configuration is good — not merely that *something* is
 * listening on the port.
 */
export async function assertDependencies(): Promise<void> {
  // Redis first: the retry storm it produces on failure is the noisiest, and
  // silencing that log while the ping resolves keeps the real message readable.
  const release = suppressRedisErrorLog();
  try {
    await redis.ping();
  } catch (err) {
    throw new StartupCheckError(formatStartupFailure('redis', process.env.REDIS_URL, err));
  } finally {
    release();
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // The RESOLVED url, not the raw variable: in standalone mode DATABASE_URL is unset by
    // design, and reporting a failure against an empty string tells the operator nothing about
    // which file could not be opened.
    throw new StartupCheckError(formatStartupFailure('database', resolveDatabaseUrl(), err));
  }
}
