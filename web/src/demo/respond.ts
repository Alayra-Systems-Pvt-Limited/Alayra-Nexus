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

// The demo's entire backend.
//
// Every typed helper in api.ts funnels through one `api(method, path, body)` call, so the static
// demo needs to answer exactly that one function — not reimplement a 641-line client. This maps a
// method and path onto the frozen dataset in ./dataset.json, which was produced by running the real
// services against a seeded gateway (see scripts/demo/buildFixtures.ts).
//
// None of this reaches a production bundle: the only caller is guarded by `import.meta.env.VITE_DEMO`,
// a compile-time constant, so Rollup removes the branch and tree-shakes this module away entirely.

import dataset from './dataset.json';

/** Thrown for a write, so callers show their normal error path rather than appearing to succeed. */
export class DemoReadOnlyError extends Error {
  readonly status = 403;
  constructor() {
    super('This is a read-only demo — changes are not saved. Run the gateway to try it for real.');
    this.name = 'DemoReadOnlyError';
  }
}

/** Thrown when the demo has no fixture for a path, so a gap is loud in development. */
export class DemoUnhandledError extends Error {
  readonly status = 404;
  constructor(method: string, path: string) {
    super(`The demo has no fixture for ${method} ${path}.`);
    this.name = 'DemoUnhandledError';
  }
}

/** Strip the query string and any trailing slash, so '/admin/teams/?x=1' matches '/admin/teams'. */
function normalise(path: string): string {
  const [p] = path.split('?');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function query(path: string): URLSearchParams {
  const i = path.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : path.slice(i + 1));
}

type Period = 'today' | '7d' | '30d' | '90d';
const PERIODS: readonly Period[] = ['today', '7d', '30d', '90d'];

function period(path: string, fallback: Period = '7d'): Period {
  const raw = query(path).get('period');
  return PERIODS.includes(raw as Period) ? (raw as Period) : fallback;
}

/** The signed-in identity the demo presents: a viewer, so no write control is offered at all. */
export const DEMO_IDENTITY = {
  role:   'viewer' as const,
  userId: 'demo-viewer',
  name:   'Demo visitor',
};

/**
 * The administrators shown on the Admin page. Deliberately the same four people the seeded audit
 * trail attributes actions to, so the log and the people list agree — a demo whose "who did this"
 * names someone absent from the team reads as fabricated.
 *
 * Addresses use .invalid (reserved by RFC 2606 and guaranteed never to resolve): this is published
 * to a public page, and the dataset's own tests reject e-mail-shaped strings for the same reason.
 */
/**
 * The demo's last backup: today's 04:00 UTC window, or yesterday's if that has not arrived yet.
 *
 * Computed at load rather than hard-coded so the card always reads "this morning" instead of ageing
 * into "8 months ago", and never written to a file, so it creates no fixture diff.
 */
const DEMO_LAST_BACKUP = (() => {
  const window = new Date();
  window.setUTCHours(4, 0, 0, 0);
  return window.getTime() > Date.now() ? window.getTime() - 86_400_000 : window.getTime();
})();

const DEMO_USERS = [
  { id: 'u-owner',  email: 'abbas@example.invalid',  name: 'Abbas Baber', role: 'owner',  status: 'active',    source: 'local', twoFactorEnabled: true,  lastLoginAt: '2026-07-20T09:14:00.000Z', createdAt: '2026-04-22T08:00:00.000Z' },
  { id: 'u-admin1', email: 'liaqat@example.invalid', name: 'Liaqat Ali',  role: 'admin',  status: 'active',    source: 'local', twoFactorEnabled: true,  lastLoginAt: '2026-07-19T16:02:00.000Z', createdAt: '2026-04-23T10:30:00.000Z' },
  { id: 'u-admin2', email: 'sana@example.invalid',   name: 'Sana Malik',  role: 'admin',  status: 'active',    source: 'sso',   twoFactorEnabled: false, lastLoginAt: '2026-07-20T07:41:00.000Z', createdAt: '2026-05-06T09:15:00.000Z' },
  { id: 'u-viewer', email: 'usman@example.invalid',  name: 'Usman Tariq', role: 'viewer', status: 'active',    source: 'local', twoFactorEnabled: false, lastLoginAt: '2026-07-19T11:20:00.000Z', createdAt: '2026-06-01T13:45:00.000Z' },
  { id: 'u-former', email: 'former@example.invalid', name: 'Bilal Ahmed', role: 'viewer', status: 'suspended', source: 'local', twoFactorEnabled: false, lastLoginAt: '2026-06-28T15:05:00.000Z', createdAt: '2026-05-19T11:00:00.000Z' },
];

/** Mirrors ROLE_LABELS (src/lib/roles.ts): the list travels with what each role means. */
const DEMO_ROLES = {
  owner:  { label: 'Owner',  description: 'Full control, including managing people, single sign-on, compliance, and the master API key.' },
  admin:  { label: 'Admin',  description: 'Runs the gateway day to day — pools, keys, models, teams, caching and settings — but cannot manage people or the gateway itself.' },
  viewer: { label: 'Viewer', description: 'Read-only. Can see every section but change nothing.' },
};

/**
 * Answer one API call from the frozen dataset.
 *
 * Writes are refused rather than faked. A demo that appears to save and then silently forgets is a
 * worse experience than one that says plainly what it is — and because the demo signs in as a
 * viewer, the UI hides write controls anyway; this is the backstop for anything that slips through.
 */
export function demoRespond<T>(method: string, path: string): T {
  const m = method.toUpperCase();
  const p = normalise(path);

  if (m !== 'GET') throw new DemoReadOnlyError();

  switch (p) {
    case '/admin/overview':            return dataset.overview as T;
    case '/admin/analytics/overview':  return dataset.analytics[period(path, '30d')] as T;
    case '/admin/nexus/overview':      return dataset.nexus as T;
    case '/admin/models':              return dataset.models as T;
    case '/admin/teams':               return { teams: dataset.teams } as T;
    case '/admin/audit':               return (Number(query(path).get('limit')) > 50 ? dataset.auditLarge : dataset.audit) as T;
    case '/admin/notifications':       return dataset.notifications as T;
    case '/admin/health/overview':     return dataset.health as T;
    case '/admin/cache/stats':         return dataset.cacheStats as T;

    // Backups (B2). The demo answered nothing here at all, so a visitor could not tell that the
    // gateway backs itself up — which is among the most reassuring things it does. Written inline
    // rather than captured, like the other configuration surfaces above: the fixture builder reads
    // a live gateway, and a seeded demo gateway has never taken a backup, so there is nothing there
    // to photograph. Shown as a healthy install — schedule on, this morning's run succeeded, files
    // present to download.
    case '/admin/backup/schedule':
      return {
        schedule: {
          enabled: true, everyDays: 1, hourUtc: 4, minuteUtc: 0, keep: 7,
          copyOffMachine: false,
          destination: { kind: 'directory', path: '' },
        },
        state: {
          lastRunAt: DEMO_LAST_BACKUP, lastOutcome: 'ok', lastError: null,
          lastFilename: 'alayra-nexus-backup-2026-08-01-04-00-00.nxb',
          lastBytes: 4_204_112, lastRows: 18_314, lastPruned: 1,
          lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null,
        },
        nextRunAt: new Date(DEMO_LAST_BACKUP + 86_400_000).toISOString(),
        dueNow: false,
        hasRecoveryKey: true,
        storedBytes: 4_204_112 * 3,
      } as T;
    // The demo gateway is presented as a real deployment, so it is already on PostgreSQL and the
    // move does not apply to it. Answering honestly is better than hiding the tab: a visitor sees
    // the option exists and that a grown-up install is past it.
    case '/admin/migrate/status':
      return { engine: 'postgres', canMigrate: false, notMigrated: ['backup', 'backupChunk'] } as T;
    case '/admin/backup/archive':
      return {
        backups: [
          { filename: 'alayra-nexus-backup-2026-08-01-04-00-00.nxb', createdAt: new Date(DEMO_LAST_BACKUP).toISOString(),                bytes: 4_204_112, rows: 18_314, origin: 'scheduled' },
          { filename: 'alayra-nexus-backup-2026-07-31-04-00-00.nxb', createdAt: new Date(DEMO_LAST_BACKUP - 86_400_000).toISOString(),   bytes: 4_188_003, rows: 18_201, origin: 'scheduled' },
          { filename: 'alayra-nexus-backup-2026-07-30-04-00-00.nxb', createdAt: new Date(DEMO_LAST_BACKUP - 172_800_000).toISOString(),  bytes: 4_151_880, rows: 18_044, origin: 'manual' },
        ],
      } as T;
    case '/admin/settings/cache':      return dataset.cacheConfig as T;

    // Identity and session shape, so the shell renders a signed-in viewer.
    case '/admin/me':
      return { user: { id: DEMO_IDENTITY.userId, name: DEMO_IDENTITY.name, email: 'demo@example.invalid', role: 'viewer' }, role: 'viewer' } as T;
    case '/admin/me/sessions':
      return { sessions: [] } as T;
    case '/admin/auth/status':
      return { totpEnabled: false, recoveryCodesRemaining: 0 } as T;

    // Configuration surfaces. The demo shows the shipped defaults rather than a operator's tuning,
    // which is both more representative and avoids implying a setting we did not capture.
    case '/admin/settings/routing':     return { costWeight: dataset.nexus?.routing?.costWeight ?? 0 } as T;
    case '/admin/settings/notifications': return { channels: [] } as T;
    case '/admin/settings/compliance':  return { auditRetentionDays: 90, usageRetentionDays: 90, anonymize: false } as T;
    case '/admin/settings/guardrails':  return { enabled: false, rules: [] } as T;
    case '/admin/settings/ssrf':        return { allowPrivateHosts: false, allowlist: [] } as T;
    case '/admin/branding':             return { companyName: null, logoDataUri: null } as T;
    // Must match GatewayConfig exactly. It did not, once: this returned `{publicUrl, source}`,
    // Connect read `data.baseUrl.replace(…)`, and the resulting TypeError killed the render
    // mid-flight — leaving the page stuck on its "Loading connection…" frame with nothing in the
    // console. Inventing a response shape instead of copying the route's is how that happens.
    case '/admin/config':
      return {
        baseUrl:       'https://nexus.example.com/v1',
        baseUrlSource: 'env',
        apiKeySet:     true,
        apiKeyMasked:  'nxs-••••••••4f2a',
        isFirstRun:    false,
      } as T;
    case '/admin/invites':              return { invites: [] } as T;

    // The people the audit trail already names, so the Admin page and the log tell the same story.
    // Addresses use .invalid (RFC 2606) — a published fixture must not carry a routable one, and
    // the dataset's own tests reject e-mail-shaped strings for the same reason.
    case '/admin/users':                return { users: DEMO_USERS, roles: DEMO_ROLES } as T;
    case '/admin/providers':            return { providers: dataset.nexus?.tiers?.flatMap((t) => t.providers) ?? [] } as T;
    case '/admin/setup/status':         return { claimed: true } as T;
    case '/admin/team-keys':            return { keys: dataset.teamKeys } as T;

    // Owner-only surfaces. A viewer is never shown these, so the demo answers with an empty list
    // rather than inventing credentials — and an empty list is the truthful answer for a gateway
    // whose only administrator interface is this demo.
    case '/admin/tokens':               return { tokens: [] } as T;
    case '/admin/models/pricing-catalog': return { entries: [] } as T;
  }

  // Per-team stats: /admin/teams/:id/stats
  const stats = p.match(/^\/admin\/teams\/([^/]+)\/stats$/);
  if (stats) {
    const key = `${stats[1]}:${period(path)}`;
    const found = (dataset.teamStats as Record<string, unknown>)[key];
    if (found) return found as T;
  }

  throw new DemoUnhandledError(m, p);
}

/** True when this build is the static demo. A compile-time constant, so it folds away in production. */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';
