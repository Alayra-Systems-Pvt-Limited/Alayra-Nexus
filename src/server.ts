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
import { startBackupScheduler } from './services/backupSchedule.service';
import { redis, usingMemoryKv } from './lib/redis';
import { deriveRateLimitKey } from './lib/rateLimitKey';
import { ensureApiKey }    from './services/apiKey.service';
import { writeSecretFile } from './lib/secretFile';
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
import cluster from 'node:cluster';
import { assertClusterSafe, desiredWorkers, ownsBackgroundJobs, ClusterUnsafeError, forkDelayMs, createCrashWindow } from './lib/cluster';
import { installCrashHandlers, onShutdown, shutdown } from './lib/lifecycle';
import { kvAwareErrorHandler } from './lib/kvUnavailable';

// Before anything else can throw. Registered at import time rather than inside `bootstrap`, because
// the window this closes includes the boot itself — `initOnce` builds a schema and talks to Redis,
// and an error escaping there deserves the same graceful exit as one escaping later.
installCrashHandlers();

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

/**
 * How long the cluster primary lingers after signalling its workers.
 *
 * Long enough for a worker to close its listener and flush, short enough to stay well inside the
 * orchestrator's grace period. A worker that needs longer has its own deadline and will be killed
 * by it, not by this.
 */
const PRIMARY_EXIT_GRACE_MS = parseInt(process.env.NEXUS_PRIMARY_EXIT_GRACE_MS ?? '3000', 10);

/**
 * Everything that must happen exactly once per deployment, whatever the worker count.
 *
 * Creating the SQLite schema, putting it into WAL, seeding the registry and generating the API
 * key are all one-time. Run in every worker they would race each other, and the key would be
 * announced four times for one key.
 */
async function initOnce() {
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
  // Phase 7.13a: the key is stored as a hash now and handed over exactly once. `ensureApiKey` also
  // converts a pre-7.13a plaintext key in place — the key keeps working, and this boot is the last
  // chance to retrieve it.
  const newKey = await ensureApiKey();
  if (newKey) {
    // To a 0600 file, not to stdout: stdout is collected by Docker, systemd and every hosted log
    // service, and a credential written there outlives the boot that printed it. The operator still
    // gets exactly one sight of the key, and one that survives a closed terminal. See lib/secretFile.
    const keyPath = writeSecretFile('api-key.txt', newKey);
    console.log('\n🔑  Generated your Nexus API Key. It cannot be shown again, and it is in:');
    console.log(`    ${keyPath}`);
    console.log('    Read it with `cat`, save it somewhere safe, then delete that file.');
    // Named no single tool. This line greets everyone who ever starts a gateway, and a Cursor user
    // is not the common case — Cursor cannot even reach a localhost gateway, as the README says a
    // few sections later. Say what the key IS, and let the reader map it to their own client.
    console.log('    Send it as:  Authorization: Bearer <key>   (or  x-api-key: <key>)\n');
  }

}

/** Build the app and take traffic. Runs in every worker. */
async function serve() {
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

  // An unreachable key-value store is somebody else's outage, and the answer has to say so.
  //
  // Without this, a Redis failure reached Fastify's default handler and became a 500 — "the gateway
  // is broken", with no Retry-After and no reason for a client to try again. It is the wrong answer
  // twice over: the gateway is fine, and the condition is temporary. A 503 with a Retry-After is
  // the one a well-written client already knows how to act on, and it is what every other
  // temporarily-unavailable path here already returns (maintenance, tier exhaustion, migrations).
  //
  // Narrow on purpose. Only errors that specifically mean "the store did not answer" are
  // translated; everything else keeps its 500 and its logging, because dressing a bug up as a
  // dependency outage tells a caller to come back later for a defect that will still be there.
  app.setErrorHandler(kvAwareErrorHandler);

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

  // The wind-down, in the order it has to happen. Registered here rather than at module scope
  // because only this function has the server: `app` is built per-worker, and a module-level
  // handle would be null in the primary and stale after a restart.
  //
  // Closing first is what makes the drains worth doing. Fastify's close stops accepting, lets
  // in-flight requests finish, and only then resolves — so by the time the buffers are flushed
  // they are no longer being written into, and the flush is complete rather than merely recent.
  onShutdown('close the listener and finish in-flight requests', () => app.close());
  onShutdown('flush buffered usage events', () => drainUsage());
  onShutdown('flush buffered audit entries', () => drainAudit());
  // No explicit WAL checkpoint here, deliberately — see the note in lib/sqlitePragma.ts.
  // $disconnect closes the last connection, and SQLite folds the -wal back in as part of that.
  onShutdown('disconnect the database', () => prisma.$disconnect());

  await app.listen({ port: PORT, host: HOST });
  console.log(`\n🚀  Alayra Nexus running on http://${HOST}:${PORT}`);
  console.log(`    OpenAI base URL → http://localhost:${PORT}/v1`);
  // Which stores this process is actually on, plus a caution when a restart would lose something.
  logMode();

}

/**
 * Timers that are not per-request work, and must not run once per worker.
 *
 * Only the first worker calls this. Retention deleting the same rows from four processes is
 * wasted contention, and four health samplers write four separate in-memory ring buffers of
 * which a dashboard read sees exactly one.
 */
function startBackgroundJobs() {
  // Compliance retention (Phase 6.7): apply the configured audit/usage retention windows
  // daily. Deletion is bounded to whatever the operator set (default 90 days; "Off" keeps
  // everything). The first pass is delayed a minute so it never contends with startup, and
  // the timer is unref'd so it cannot hold the process open on its own.
  //
  // The `.catch` is not decoration. `runRetention` guards each of its three deletes but not the
  // settings read that precedes them, and that read goes to the key-value store — so on a gateway
  // whose Redis is unreachable this timer produced a rejected promise with nobody holding it, one
  // minute after boot. An unhandled rejection ends the process (see lib/lifecycle.ts), which is a
  // remarkable way for a housekeeping job to take a gateway down. Retention is best-effort by
  // nature: the rows it did not delete today are still there tomorrow.
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const onRetentionError = (err: unknown) =>
    console.warn('  Retention pass skipped:', err instanceof Error ? err.message : err);
  const firstPass = setTimeout(() => { void runRetention().catch(onRetentionError); }, 60_000);
  const retentionTimer = setInterval(() => { void runRetention().catch(onRetentionError); }, RETENTION_INTERVAL_MS);
  if (typeof firstPass.unref === 'function') firstPass.unref();
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();

  // Health sampler (Phase 7.12): one small probe of Redis/Postgres/the event loop every 15s into an
  // in-memory ring buffer — the hour of history behind the Health page's sparklines and status
  // strip. Off the request path; its own timer is unref'd inside.
  startHealthSampler();

  // Scheduled backups (Phase B2): once a minute, ask whether one is owed and take it if so. Off
  // until an operator switches it on, so this costs one small query a minute on a gateway that has
  // not configured it. A Redis lock means only one instance of a scaled deployment ever runs it,
  // and the timer is unref'd so it cannot hold the process open.
  startBackupScheduler();
}

/**
 * One process, or several sharing the listening socket.
 *
 * The primary does the one-time work and then serves nothing itself — it only supervises. Workers
 * skip `initOnce` entirely: by the time they exist the schema is built, the registry is seeded and
 * the key is generated, and repeating any of that would at best be noise and at worst a race.
 *
 * See lib/cluster.ts for why this refuses to fork without a shared Redis.
 */
async function bootstrap() {
  const workers = desiredWorkers();

  if (workers > 1 && cluster.isPrimary) {
    // Before anything is forked, and before the one-time work: an operator who asked for something
    // unsafe should learn about it immediately, not after a schema has been built.
    assertClusterSafe(workers, { usingMemoryKv, dbEngine });

    await initOnce();

    console.log(`\n🚀  Alayra Nexus starting ${workers} workers on http://${HOST}:${PORT}`);
    for (let i = 0; i < workers; i++) cluster.fork();

    // A worker that dies takes its share of the traffic with it until something replaces it. Not
    // restarted after an explicit shutdown, or the gateway could never be stopped.
    //
    // The delay is the difference between supervision and a spin — see the note above
    // `forkDelayMs`. Zero for the first death in a minute, doubling after that, so a single bad
    // request recovers instantly while a dependency outage that kills every worker at boot settles
    // into a probe every thirty seconds instead of pinning a core.
    let stopping = false;
    const crashes = createCrashWindow();
    cluster.on('exit', (worker, code, signal) => {
      if (stopping) return;
      const delay = forkDelayMs(crashes.record(Date.now()));
      const wait = delay > 0 ? ` — replacing in ${(delay / 1000).toFixed(1)}s` : ' — replacing now';
      console.error(`  worker ${worker.process.pid} exited (${signal ?? code})${wait}`);
      if (delay === 0) { cluster.fork(); return; }
      // Not unref'd: while the gateway is down to fewer workers than it was asked for, this timer
      // is the only thing that will bring one back, and a process that exited instead would leave
      // an operator with a supervisor that had silently stopped supervising.
      setTimeout(() => { if (!stopping) cluster.fork(); }, delay);
    });

    // The primary owns no sockets, so the only thing it has to do on the way out is take the
    // workers with it. Without this they are re-parented and keep the port bound.
    //
    // It also has nothing to drain — the buffers belong to the workers — so it registers its own
    // handler and never the shared one. Registering both was a real bug: this function's
    // synchronous `process.exit(0)` ran while the shared handler was still awaiting its first
    // flush, so the drain was cut off in the middle by the process it was sharing.
    //
    // The workers are given a moment to drain before the primary leaves. Not waited on: a worker
    // stuck mid-flush must not be able to prevent the gateway from stopping, and each one has its
    // own deadline for exactly that reason.
    const stop = (): void => {
      stopping = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.kill('SIGTERM');
      setTimeout(() => process.exit(0), PRIMARY_EXIT_GRACE_MS);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }

  // A worker: the primary has already done initOnce. Dependencies are still checked, because each
  // worker opens its own connections and a worker that cannot reach the database should say so
  // rather than serve 500s.
  if (cluster.isWorker) {
    await assertDependencies();
    await serve();
    // MUTATION: signal handlers deliberately not installed
    if (ownsBackgroundJobs(cluster.worker?.id)) startBackgroundJobs();
    return;
  }

  // The ordinary single-process gateway, unchanged.
  await initOnce();
  await serve();
  // MUTATION: signal handlers deliberately not installed
  startBackgroundJobs();
}

bootstrap().catch((err) => {
  // A missing dependency already carries a complete, actionable message; its stack
  // is noise. So does an unsafe cluster configuration. Anything else is a real bug and keeps
  // its stack.
  if (err instanceof StartupCheckError) console.error(err.message);
  else if (err instanceof ClusterUnsafeError) console.error(`\n✗ ${err.message}\n`);
  else console.error('Fatal startup error:', err);
  process.exit(1);
});

// A signal is a deliberate stop, so it exits 0 — which is also what tells a supervisor configured
// with `on-failure` to leave the process alone rather than bring it back. The crash path in
// lib/lifecycle.ts exits 1 for the opposite reason. The steps themselves are registered in
// `serve()`, where the server instance they close actually exists.
function installSignalHandlers(): void {
  process.on('SIGTERM', () => { void shutdown(0); });
  process.on('SIGINT',  () => { void shutdown(0); });
}
