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
// Must stay in this position: after dotenv (which populates process.env) and before every other
// import. It checks the storage configuration, and lib/redis.ts throws on import when REDIS_URL is
// unset — so anything imported ahead of this would pre-empt the useful message with that bare one.
// Only `logMode` is needed here. Nothing else in the codebase may import this module: it exits the
// process on a bad configuration, which inside a test run would kill the runner. Everywhere else
// imports the pure `resolveMode` from lib/mode instead.
import { logMode } from './bootGuard';
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
import { startHealthSampler, runReadyChecks } from './services/healthSampler.service';
import { redis, usingMemoryKv } from './lib/redis';
import { deriveRateLimitKey } from './lib/rateLimitKey';
import { ensureApiKey }    from './services/apiKey.service';
import { reconcilePoolsToRegistry } from './services/model.service';
import { drainUsage }     from './services/usagePipeline';
import { drainAudit, runRetention } from './services/audit.service';
import { metricsText, metricsContentType } from './lib/metrics';
import { verifyMetricsToken } from './middleware/auth.middleware';
import { assertDependencies, StartupCheckError } from './services/preflight.service';
import { prisma, dbEngine } from './lib/prisma';
import { ensureSqliteSchema } from './lib/sqliteBootstrap';
import { configureSqlite } from './lib/sqlitePragma';
import { resolveDatabaseUrl } from './lib/mode';
import { isSpaNavigation } from './lib/spaFallback';
import { normalizePublicUrl } from './lib/baseUrl';

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
  // Fail with an instruction, not a retry storm, when the database or Redis is missing.
  await assertDependencies();

  // Standalone only (S2.4): build the database if this is a first run. It has to happen here rather
  // than in a deploy step because `npx @alayra/nexus` has no deploy step — and it has to happen
  // AFTER assertDependencies so an unreachable database is still reported as such, not as a failure
  // to create a schema. `SELECT 1` passes against an empty SQLite file, so nothing before this point
  // can tell the difference between a working gateway and one with no tables.
  if (dbEngine === 'sqlite') {
    const { created, tables } = await ensureSqliteSchema(prisma);
    if (created) console.log(`  Database created → ${tables} tables at ${resolveDatabaseUrl().replace(/^file:/, '')}`);

    // And put it into WAL (S2.5), so background writes stop queueing behind dashboard reads. After
    // the schema, because there is no point configuring a database that does not exist yet — and
    // never fatal: a file that will not take WAL is slower, not unusable.
    const tuning = await configureSqlite(prisma);
    if (tuning.warning) console.warn(`  ⚠ ${tuning.warning}`);
  }

  // PUBLIC_URL (P7.14): the operator's pin for every URL the gateway prints — the Connect page,
  // quick-start snippets, the SSO redirect_uri. Validated at boot and fatal when malformed: a bad
  // pin would misprint every one of those with total confidence, which is strictly worse than
  // crashing with the reason. Unset means inference from proxy headers stays in charge.
  if (process.env.PUBLIC_URL?.trim()) {
    try {
      console.log(`  Public URL pinned → ${normalizePublicUrl(process.env.PUBLIC_URL)}`);
    } catch (err) {
      console.error(`\n✗ ${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  }

  // Phase 6.1 transition: seed the model registry from any pool that still carries a
  // preferred model, so routing behaves exactly as before the model-first switch.
  // Non-fatal — a registry hiccup must never stop the gateway starting.
  try {
    const seeded = await reconcilePoolsToRegistry();
    if (seeded > 0) console.log(`  Seeded ${seeded} model(s) into the registry from existing pools.`);
  } catch (err) {
    console.warn('  Model registry reconcile skipped:', err instanceof Error ? err.message : err);
  }

  // ── Generate the API key on first run, and hash an existing one ──
  // Phase 7.13a: the key is stored as a hash now and shown exactly once. `ensureApiKey` also
  // converts a pre-7.13a plaintext key in place — the key keeps working, and that boot's log is
  // the last time it can be printed.
  const newKey = await ensureApiKey();
  if (newKey) {
    console.log('\n🔑  Generated Nexus API Key — SAVE IT NOW, it cannot be shown again:');
    console.log(`    ${newKey}`);
    // Named no single tool. This line greets everyone who ever starts a gateway, and a Cursor user
    // is not the common case — Cursor cannot even reach a localhost gateway, as the README says a
    // few sections later. Say what the key IS, and let the reader map it to their own client.
    console.log('    Send it as:  Authorization: Bearer <key>   (or  x-api-key: <key>)\n');
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Tool-mercy rewrite — must live HERE, not in an onRequest hook: Fastify routes the request
    // BEFORE any hook runs, so a hook rewrites too late and the 404 is already chosen. Many
    // clients take a "base URL" and append `/v1/...` themselves; an operator who pastes the
    // Connect page's `https://gateway/v1` into such a tool produces `/v1/v1/models`, a request
    // that is unambiguous about what it wants and used to get a 404 that looked like an outage.
    // Collapse the doubled prefix exactly once; a tripled one stays the honest 404 it deserves.
    rewriteUrl(req) {
      const url = req.url ?? '/';
      return url.startsWith('/v1/v1/') ? url.slice('/v1'.length) : url;
    },
  });

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
  // Redis-backed when a Redis exists, so the limit stays correct across horizontally-scaled
  // instances (an in-memory store under-counts the moment you run more than one replica). Without
  // Redis there is only one process to count for, so the plugin's own store is exact — and running
  // more than one replica in that mode is precisely what standalone mode says not to do.
  // Keyed per-credential (sha256 of the bearer token) so a single leaked or
  // runaway team key is isolated to its own bucket instead of throttling the
  // whole gateway; falls back to client IP for missing/malformed auth.
  await app.register(rateLimit, {
    // Only when there is a real Redis. The plugin drives it through `defineCommand`, an ioredis
    // facility for registering server-side Lua — not something an in-process store can offer, and
    // handing it one crashes the boot with `defineCommand is not a function`. Omitting the option
    // makes the plugin use its own in-process counter, which is the right store in that mode anyway:
    // there is exactly one process, so a shared one would be indirection with no purpose.
    ...(usingMemoryKv ? {} : { redis }),
    max:        ABUSE_RATE_LIMIT_MAX,
    timeWindow: ABUSE_RATE_LIMIT_WINDOW,
    skipOnError: true, // fail open: a Redis blip must never take the proxy down
    keyGenerator: (request) => deriveRateLimitKey(request.headers.authorization, request.ip),
    // Probes and metrics must never be throttled — orchestrators/scrapers poll them
    // constantly. /metrics is exempt from the rate limit but NOT from auth (below).
    allowList: (request) => request.url === '/health' || request.url === '/ready' || request.url === '/metrics',
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

  // Probes (Phase 7.12). Two URLs on purpose, because orchestrators ask two different questions:
  // /health = liveness — "is the process alive, should I restart it?" It deliberately checks
  // NOTHING external: restarting the gateway cannot fix a dead database, and a liveness probe that
  // fails on a dependency turns every database blip into a restart loop.
  // /ready = readiness — "can this instance serve traffic?" It really probes Redis and Postgres and
  // answers 503 when a dependency is down, with the per-check detail, so a load balancer stops
  // routing to an instance that cannot serve. Degraded-but-answering still says ready: pulling a
  // slow gateway out of rotation turns a slowdown into an outage.
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));
  app.get('/ready', async (_req, reply) => {
    const r = await runReadyChecks();
    return reply.code(r.ready ? 200 : 503).send({
      ready: r.ready, status: r.status, ts: new Date().toISOString(),
      checks: r.checks.map((c) => ({ id: c.id, label: c.label, measured: c.measured, threshold: c.threshold, status: c.status })),
    });
  });

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
  // Which stores this process is actually on, plus a caution when a restart would lose something.
  logMode();

  // Compliance retention (Phase 6.7): apply the configured audit/usage retention windows
  // daily. Deletion is bounded to whatever the operator set (default 90 days; "Off" keeps
  // everything). The first pass is delayed a minute so it never contends with startup, and
  // the timer is unref'd so it cannot hold the process open on its own.
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const firstPass = setTimeout(() => { void runRetention(); }, 60_000);
  const retentionTimer = setInterval(() => { void runRetention(); }, RETENTION_INTERVAL_MS);
  if (typeof firstPass.unref === 'function') firstPass.unref();
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();

  // Health sampler (Phase 7.12): one small probe of Redis/Postgres/the event loop every 15s into an
  // in-memory ring buffer — the hour of history behind the Health page's sparklines and status
  // strip. Off the request path; its own timer is unref'd inside.
  startHealthSampler();
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
  // No explicit WAL checkpoint here, deliberately — see the note in lib/sqlitePragma.ts. $disconnect
  // closes the last connection, and SQLite folds the -wal back in and removes it as part of that.
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
