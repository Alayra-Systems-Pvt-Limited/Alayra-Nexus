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

import 'dotenv/config';
import Fastify            from 'fastify';
import cors               from '@fastify/cors';
import helmet             from '@fastify/helmet';
import rateLimit          from '@fastify/rate-limit';
import multipart          from '@fastify/multipart';
import staticFiles        from '@fastify/static';
import path               from 'path';
import proxyRoutes        from './routes/proxy';
import adminRoutes        from './routes/admin';
import brandingRoutes     from './routes/branding.routes';
import { prisma }         from './lib/prisma';
import { redis }          from './lib/redis';
import { deriveRateLimitKey } from './lib/rateLimitKey';
import { getSetting, setSetting } from './services/settings.service';
import { reconcilePoolsToRegistry } from './services/model.service';
import { drainUsage }     from './services/usagePipeline';
import { drainAudit, runRetention } from './services/audit.service';
import { metricsText, metricsContentType } from './lib/metrics';
import { verifyMetricsToken } from './middleware/auth.middleware';
import { assertDependencies, StartupCheckError } from './services/preflight.service';
import { isSpaNavigation } from './lib/spaFallback';
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
  // Fail with an instruction, not a retry storm, when Postgres or Redis is missing.
  await assertDependencies();

  // Phase 6.1 transition: seed the model registry from any pool that still carries a
  // preferred model, so routing behaves exactly as before the model-first switch.
  // Non-fatal — a registry hiccup must never stop the gateway starting.
  try {
    const seeded = await reconcilePoolsToRegistry();
    if (seeded > 0) console.log(`  Seeded ${seeded} model(s) into the registry from existing pools.`);
  } catch (err) {
    console.warn('  Model registry reconcile skipped:', err instanceof Error ? err.message : err);
  }

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

  // Multipart uploads — only /v1/audio/transcriptions uses them. Bounded so an
  // oversized upload is rejected early rather than buffered into memory. JSON routes
  // are unaffected; this parser engages only for multipart/form-data content types.
  await app.register(multipart, {
    limits: {
      fileSize: parseInt(process.env.MAX_UPLOAD_BYTES ?? String(26 * 1024 * 1024), 10), // 26 MB, ~OpenAI's cap
      files:    1,
    },
  });

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
    // Health and metrics must never be throttled — orchestrators/scrapers poll them
    // constantly. /metrics is exempt from the rate limit but NOT from auth (below).
    allowList: (request) => request.url === '/health' || request.url === '/metrics',
  });

  await app.register(staticFiles, {
    // The redesigned dashboard's static build (Phase 7.9 cutover). `__dirname` is `dist/` after a
    // build, so this resolves to the repo root's `web/dist` in dev and `/app/web/dist` in the
    // container — which is why the Dockerfile must build web/ and copy web/dist into the runtime
    // stage. `wildcard: false` registers a route per built file (plus index.html at `/`) and lets
    // every unmatched path fall through to the not-found handler below, where the SPA fallback lives.
    root:     path.join(__dirname, '..', 'web', 'dist'),
    prefix:   '/',
    wildcard: false,
  });

  // SPA deep-link fallback: a browser navigation to a client-side route (/teams, /nexus, /admin …)
  // matches no file and no API route, so it lands here. We hand back index.html and let the client
  // router resolve it; a non-browser request (an API client, or the gateway's own namespaces) keeps
  // the honest JSON 404. See lib/spaFallback.ts for why the Accept header, not a route list, decides.
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (isSpaNavigation(request.method, request.headers.accept, pathname)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: `Route ${request.method} ${pathname} not found` });
  });

  // Health
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Prometheus metrics — auth-guarded (bearer METRICS_TOKEN or ADMIN_PASSWORD),
  // exempt from the abuse guard above so a scraper is never rate-limited.
  app.get('/metrics', { preHandler: [verifyMetricsToken] }, async (_req, reply) => {
    reply.header('Content-Type', metricsContentType);
    return reply.send(await metricsText());
  });

  await app.register(proxyRoutes);
  await app.register(adminRoutes);
  // Public branding read (Phase 7.11) — the sign-in screen renders the operator's name and logo
  // before any session exists, so it sits outside the admin router. The write is owner-guarded.
  await app.register(brandingRoutes);

  await app.listen({ port: PORT, host: HOST });
  console.log(`\n🚀  Alayra Nexus running on http://${HOST}:${PORT}`);
  console.log(`    OpenAI base URL → http://localhost:${PORT}/v1`);

  // Compliance retention (Phase 6.7): apply the configured audit/usage retention windows
  // daily. Deletion is bounded to whatever the operator set (default 90 days; "Off" keeps
  // everything). The first pass is delayed a minute so it never contends with startup, and
  // the timer is unref'd so it cannot hold the process open on its own.
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const firstPass = setTimeout(() => { void runRetention(); }, 60_000);
  const retentionTimer = setInterval(() => { void runRetention(); }, RETENTION_INTERVAL_MS);
  if (typeof firstPass.unref === 'function') firstPass.unref();
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
}

bootstrap().catch((err) => {
  // A missing dependency already carries a complete, actionable message; its stack
  // is noise. Anything else is a real bug and keeps its stack.
  if (err instanceof StartupCheckError) console.error(err.message);
  else console.error('Fatal startup error:', err);
  process.exit(1);
});

async function shutdown() {
  // Flush any buffered usage events and audit entries before the process exits so nothing
  // still in an in-process pipeline is lost on restart/redeploy.
  try { await drainUsage(); } catch { /* best effort */ }
  try { await drainAudit(); } catch { /* best effort */ }
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
