import { prisma }           from '../lib/prisma';
import { redis }            from '../lib/redis';
import { decrypt, maskKey } from '../lib/encryption';

export { maskKey };

export interface NexusPoolResult {
  keyId:        string;
  decryptedKey: string;
  baseUrl:      string | null;
  rpmLimit:     number;
  tpmLimit:     number;
}

function providerDefaultUrl(provider: string): string {
  switch (provider) {
    case 'openai':     return 'https://api.openai.com/v1';
    case 'anthropic':  return 'https://api.anthropic.com/v1';
    case 'google':     return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'groq':       return 'https://api.groq.com/openai/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    default:           return '';
  }
}

export async function discoverPool(provider: string): Promise<NexusPoolResult | null> {
  const providerRow = await prisma.nexusProvider.findFirst({
    where: { provider, isActive: true },
  });
  if (!providerRow) return null;

  const now  = new Date();
  const keys = await prisma.nexusKey.findMany({
    where: {
      providerId: providerRow.id,
      status:     'active',
      OR: [{ coolingUntil: null }, { coolingUntil: { lte: now } }],
    },
    orderBy: { lastUsedAt: 'asc' },
  });

  for (const key of keys) {
    const rpmKey   = `nexus:rpm:${key.id}`;
    const rpmCount = parseInt((await redis.get(rpmKey)) ?? '0', 10);
    if (rpmCount >= key.rpmLimit) continue;

    await redis.incr(rpmKey);
    await redis.expire(rpmKey, 60);
    await prisma.nexusKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });

    return {
      keyId:        key.id,
      decryptedKey: decrypt(key.encryptedKey),
      baseUrl:      providerRow.baseUrl ?? null,
      rpmLimit:     key.rpmLimit,
      tpmLimit:     key.tpmLimit,
    };
  }
  return null;
}

export async function recordMetric(_label: string, tokens: number): Promise<void> {
  // No-op for stream label arg — just a hook for future per-key TPM tracking
  void tokens;
}

export async function banKey(keyId: string): Promise<void> {
  await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'banned' } });
}

export async function coolKey(keyId: string, seconds = 60): Promise<void> {
  const until = new Date(Date.now() + seconds * 1000);
  await prisma.nexusKey.update({ where: { id: keyId }, data: { status: 'cooling', coolingUntil: until } });
}

export async function testKey(keyId: string): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  const key = await prisma.nexusKey.findUnique({
    where:   { id: keyId },
    include: { provider: true },
  });
  if (!key) return { success: false, error: 'Key not found' };

  const apiKey  = decrypt(key.encryptedKey);
  const baseUrl = key.provider.baseUrl ?? providerDefaultUrl(key.provider.provider);
  const start   = Date.now();

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { [key.provider.authHeader]: `${key.provider.authPrefix ?? 'Bearer'} ${apiKey}` },
      signal:  AbortSignal.timeout(5000),
    });
    return { success: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
