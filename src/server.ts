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
import { getSetting, setSetting } from './services/settings.service';
import { randomUUID }     from 'crypto';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

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
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
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
