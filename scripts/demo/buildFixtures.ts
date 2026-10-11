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

// Freezes a seeded gateway's API responses into the static demo's dataset.
//
//   npm run demo:fixtures            -- against a local seeded gateway
//
// The responses are produced by calling the REAL services, not by reimplementing their aggregation
// in the browser. That is the whole point: a hand-written fixture drifts from the product the first
// time an aggregate changes, and a demo that shows numbers the gateway would never produce is worse
// than no demo. Here the demo is, by construction, a photograph of a real gateway.
//
// Services are called directly rather than over HTTP so no session token is needed — this reads a
// database, it never authenticates.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../src/lib/prisma';
import { getOverview } from '../../src/services/overview.service';
import { getAnalyticsOverview } from '../../src/services/analytics.service';
import { getNexusOverview } from '../../src/services/nexusOverview.service';
import { getTeamStats } from '../../src/services/teamStats.service';
import { getModelRegistry } from '../../src/services/model.service';
import { queryAuditLogs } from '../../src/services/audit.service';
import { listNotifications } from '../../src/services/notificationFeed.service';
import { getHealthOverview, takeSample } from '../../src/services/healthSampler.service';
import { getCacheConfigForUI } from '../../src/services/cache.service';
import { getCacheStats } from '../../src/services/cacheStats.service';
import { getCurrentSpend } from '../../src/services/budget.service';
import { CAPABILITIES } from '../../src/lib/modelSelect';
import { installPrismaCoreStores } from '../../src/adapters/prisma/install';

// Services here read through the core's storage ports, as they do in the server.
installPrismaCoreStores();

const OUT_DIR  = join(__dirname, '..', '..', 'web', 'src', 'demo');
const OUT_FILE = join(OUT_DIR, 'dataset.json');

type Json = Record<string, unknown>;

/**
 * Aggregates that failed. Collected rather than thrown so one missing surface does not abort a
 * build — but see the refusal at the end of main(): a run where everything failed must NOT quietly
 * write a dataset of nulls over a good one.
 *
 * This is not hypothetical. A rebuild once ran against a database whose host port had silently
 * disappeared, every aggregate fell back, and the script cheerfully replaced a 172 KB dataset with
 * 2 KB of nulls and reported success. Only the fact that the file was committed saved it.
 */
const failures: string[] = [];

/** Record a failed aggregate and carry on with a fallback. */
async function attempt<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`  ! ${label}: ${err instanceof Error ? err.message : err} — using fallback`);
    return fallback;
  }
}

/**
 * The teams list is assembled inline in teams.routes.ts rather than in a service, so it is
 * reproduced here. Kept deliberately literal — field for field, in the same order — so a drift
 * between the two is visible in a diff instead of hiding behind a helper.
 */
async function buildTeamsList() {
  const teams = await prisma.team.findMany({
    include: { _count: { select: { teamKeys: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return Promise.all(teams.map(async (t) => ({
    id:               t.id,
    name:             t.name,
    status:           t.status,
    assignedTier:     t.assignedTier,
    budgetUsd:        t.budgetUsd,
    budgetPeriod:     t.budgetPeriod,
    overBudgetAction: t.overBudgetAction,
    byokFallback:     t.byokFallback,
    keyCount:         t._count.teamKeys,
    spendUsd:         await getCurrentSpend(t.id, t.budgetPeriod as 'daily' | 'weekly' | 'monthly'),
    createdAt:        t.createdAt,
  })));
}

/**
 * The Teams page's "Access keys" tab. Assembled inline in teams.routes.ts rather than in a service,
 * so it is reproduced here field for field — a drift between the two should be visible in a diff.
 * Only the MASK ships; the encrypted key and its hash never leave the database.
 */
async function buildTeamKeys() {
  const keys = await prisma.nexusTeamKey.findMany({
    orderBy: { createdAt: 'asc' },
    include: { team: { select: { id: true, name: true } } },
  });
  return keys.map((k) => ({
    id: k.id, name: k.name, maskedKey: k.maskedKey, team: k.team, createdAt: k.createdAt,
  }));
}

async function main() {
  console.log('\nBuilding demo fixtures from the seeded gateway\n');

  const overview = await attempt('overview', () => getOverview(), null);
  console.log(`  overview        ${overview ? `${overview.stats.totalRequests} requests` : 'FAILED'}`);

  const periods = ['today', '7d', '30d', '90d'] as const;
  const analytics: Json = {};
  for (const p of periods) {
    analytics[p] = await attempt(`analytics ${p}`, () => getAnalyticsOverview(p), null);
  }
  console.log(`  analytics       ${periods.filter((p) => analytics[p]).length}/${periods.length} periods`);

  const nexus = await attempt('nexus overview', () => getNexusOverview(), null);
  console.log(`  pools           ${nexus ? nexus.summary.providers : 'FAILED'} providers, ${nexus ? nexus.summary.totalKeys : '?'} keys`);

  const models = await attempt('models', () => getModelRegistry(), []);
  console.log(`  models          ${models.length}`);

  const teams = await attempt('teams', () => buildTeamsList(), []);
  console.log(`  teams           ${teams.length}`);

  // Per-team stats for every team and every window the tab offers, so switching either in the demo
  // is instant and never shows a gap.
  const statsPeriods = ['today', '7d', '30d', '90d'] as const;
  const teamStats: Json = {};
  for (const t of teams) {
    for (const p of statsPeriods) {
      teamStats[`${t.id}:${p}`] = await attempt(`team stats ${t.name} ${p}`, () => getTeamStats(t.id, p), null);
    }
  }
  console.log(`  team stats      ${Object.keys(teamStats).length} combinations`);

  // `/admin/audit` answers `{ entries }`, and the service returns the bare array — the envelope is
  // added by the route. Fixtures are stored in the WIRE shape, so the demo responder can hand them
  // back untouched and the client cannot tell the difference.
  const auditEntries      = await attempt('audit', () => queryAuditLogs({ limit: 50 }), []);
  const auditEntriesLarge = await attempt('audit 200', () => queryAuditLogs({ limit: 200 }), []);
  const audit      = { entries: auditEntries };
  const auditLarge = { entries: auditEntriesLarge };
  console.log(`  audit           ${auditEntries.length} of ${auditEntriesLarge.length}`);

  const notifications = await attempt(
    'notifications',
    () => listNotifications({ limit: 20 }),
    { notifications: [], unreadCount: 0 },
  );
  console.log(`  notifications   ${notifications.notifications.length} (${notifications.unreadCount} unread)`);

  const teamKeys = await attempt('team keys', () => buildTeamKeys(), []);
  console.log(`  team keys       ${teamKeys.length}`);

  // getHealthOverview() reads an in-memory ring buffer that a background sampler fills inside the
  // long-lived gateway process. This script is short-lived, so that buffer starts empty and every
  // `?? false` in the overview defaults to DOWN — which is how the demo first shipped claiming
  // "Redis is not responding" about a gateway that was perfectly healthy.
  //
  // Taking real samples here fixes it honestly: these are genuine PING and SELECT 1 round-trips
  // against the same Redis and Postgres every other aggregate was read from. A few spaced samples
  // also give the sparkline something truthful to draw.
  for (let i = 0; i < 5; i++) {
    await attempt(`health sample ${i + 1}`, () => takeSample(), null);
  }
  const health = await attempt('health', () => getHealthOverview(), null);
  if (health && health.status !== 'healthy') {
    console.warn(`  ! health reads "${health.status}" — ${health.summary}`);
  }
  const cacheStats  = await attempt('cache stats', () => getCacheStats(), null);
  const cacheConfig = await attempt('cache config', () => getCacheConfigForUI(), null);
  console.log(`  health/cache    ${health ? 'ok' : 'FAILED'} / ${cacheStats ? 'ok' : 'FAILED'}`);

  const dataset = {
    // Stamped by the caller, never by this script: Date.now() here would make every rebuild a diff.
    generatedAt: process.env.DEMO_STAMP ?? '',
    overview,
    analytics,
    nexus,
    models: { models, capabilities: CAPABILITIES },
    teams,
    teamKeys,
    teamStats,
    audit,
    auditLarge,
    notifications,
    health,
    cacheStats,
    cacheConfig,
  };

  // Refuse to publish an empty demo.
  //
  // The per-aggregate fallbacks keep one missing surface from aborting a build, but together they
  // also mean a run against an unreachable database "succeeds" with every field null — and then
  // overwrites a good dataset with nothing. The overview is the load-bearing one: the whole demo is
  // a photograph of a used gateway, and a demo showing zero requests says the product does nothing.
  const empty = !overview || overview.stats.totalRequests === 0 || teams.length === 0;
  if (empty || failures.length > 3) {
    console.error(`\n  REFUSING TO WRITE — the source gateway did not answer.\n`);
    for (const f of failures.slice(0, 6)) console.error(`    ${f}`);
    console.error(`\n  ${OUT_FILE} was left untouched.`);
    console.error(`  Check DATABASE_URL and REDIS_URL point at a seeded gateway (npm run seed), then retry.\n`);
    process.exitCode = 1;
    return;
  }

  if (failures.length) {
    console.warn(`\n  ${failures.length} aggregate(s) fell back — the demo will show defaults for those.`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 2));

  const kb = Math.round(JSON.stringify(dataset).length / 1024);
  console.log(`\n  wrote ${OUT_FILE} (${kb} KB)\n`);
}

main()
  .catch((err) => { console.error(`\n${err instanceof Error ? err.stack : err}\n`); process.exitCode = 1; })
  // The services open a Prisma pool and a Redis connection that keep the loop alive; this is a
  // one-shot build script, so close what we can and leave rather than hang.
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
