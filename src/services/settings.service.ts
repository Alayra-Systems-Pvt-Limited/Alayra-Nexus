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
import { redis }  from '../lib/redis';

const CACHE_TTL = 300; // 5 min

export async function getSetting(key: string): Promise<string | null> {
  const cached = await redis.get(`nexus:setting:${key}`);
  if (cached !== null) return cached === '__null__' ? null : cached;
  const row = await prisma.appSettings.findUnique({ where: { key } });
  const value = row?.value ?? null;
  await redis.set(`nexus:setting:${key}`, value ?? '__null__', 'EX', CACHE_TTL);
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSettings.upsert({
    where:  { key },
    create: { key, value },
    update: { value },
  });
  await redis.set(`nexus:setting:${key}`, value, 'EX', CACHE_TTL);
}
