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
