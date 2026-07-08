import 'dotenv/config';
import Fastify            from 'fastify';
import cors               from '@fastify/cors';
import helmet             from '@fastify/helmet';
import rateLimit          from '@fastify/rate-limit';
import staticFiles        from '@fastify/static';
import path               from 'path';
import proxyRoutes        from './routes/proxy';
import adminRoutes        from './routes/admin';
import { prisma }         from './lib/prisma';
import { redis }          from './lib/redis';
import { deriveRateLimitKey } from './lib/rateLimitKey';
import { getSetting, setSetting } from './services/settings.service';
import { randomUUID }     from 'crypto';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Abuse guard sizing ───────────────────────────────────────────────
// This is NOT a throughput cap. Real throughput is governed per-key by the
// provider RPM/TPM limits inside the pool (nexus.service). This server-level
// guard exists only to blunt runaway clients / DoS, and is deliberately sized
// well above any single credential's legitimate rate. Operators size it to
// their pool via env; see README "Rate limits, explained".
const ABUSE_RATE_LIMIT_MAX    = parseInt(process.env.ABUSE_RATE_LIMIT_MAX ?? '12000', 10);
const ABUSE_RATE_LIMIT_WINDOW = process.env.ABUSE_RATE_LIMIT_WINDOW ?? '1 minute';

async function bootstrap() {
  // ── Generate API key on first run ────────────────────────────────
  const existing = await getSetting('NEXUS_API_KEY');
  if (!existing || existing === 'REPLACE_ON_INIT') {
    const key = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await setSetting('NEXUS_API_KEY', key);
    console.log('\n🔑  Generated Nexus API Key (save this):');
    console.log(`    ${key}`);
    console.log('    Add it to Cursor as: Authorization: Bearer <key>\n');
  }

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors,   { origin: true });

  // ── Abuse guard (NOT a throughput cap — see note above) ──────────────
  // Redis-backed so the limit is correct across horizontally-scaled instances
  // (an in-memory store would under-count once you run more than one replica).
  // Keyed per-credential (sha256 of the bearer token) so a single leaked or
  // runaway team key is isolated to its own bucket instead of throttling the
  // whole gateway; falls back to client IP for missing/malformed auth.
  await app.register(rateLimit, {
    redis,
    max:        ABUSE_RATE_LIMIT_MAX,
    timeWindow: ABUSE_RATE_LIMIT_WINDOW,
    skipOnError: true, // fail open: a Redis blip must never take the proxy down
    keyGenerator: (request) => deriveRateLimitKey(request.headers.authorization, request.ip),
    // Health checks must never be throttled — orchestrators poll them constantly.
    allowList: (request) => request.url === '/health',
  });

  await app.register(staticFiles, {
    root:   path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // Health
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(proxyRoutes);
  await app.register(adminRoutes);

  await app.listen({ port: PORT, host: HOST });
  console.log(`\n🚀  Kinetic Nexus running on http://${HOST}:${PORT}`);
  console.log(`    OpenAI base URL → http://localhost:${PORT}/v1`);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
