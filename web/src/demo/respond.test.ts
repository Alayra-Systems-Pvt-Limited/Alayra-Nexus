/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { demoRespond, DemoReadOnlyError, DemoUnhandledError } from './respond';
import dataset from './dataset.json';

describe('demo responder — reads', () => {
  // Every path the dashboard actually requests. If a page is added that fetches something new, this
  // list is where the omission shows up, rather than as a blank panel in the published demo.
  const PATHS = [
    '/admin/overview',
    '/admin/analytics/overview?period=30d',
    '/admin/nexus/overview',
    '/admin/models',
    '/admin/teams',
    '/admin/audit?limit=50',
    '/admin/notifications?limit=20',
    '/admin/health/overview',
    '/admin/cache/stats',
    '/admin/settings/cache',
    '/admin/settings/routing',
    '/admin/settings/compliance',
    '/admin/settings/guardrails',
    '/admin/settings/ssrf',
    '/admin/settings/notifications',
    '/admin/branding',
    '/admin/config',
    '/admin/invites',
    '/admin/providers',
    '/admin/me',
    '/admin/me/sessions',
    '/admin/auth/status',
    '/admin/setup/status',
  ];

  it.each(PATHS)('answers GET %s', (path) => {
    const res = demoRespond<unknown>('GET', path);
    expect(res).toBeDefined();
    expect(res).not.toBeNull();
  });

  it('returns the real overview aggregate', () => {
    const res = demoRespond<typeof dataset.overview>('GET', '/admin/overview');
    expect(res.stats.totalRequests).toBe(dataset.overview.stats.totalRequests);
    expect(res.series7d.length).toBeGreaterThan(0);
  });

  it('selects the analytics window from the query string', () => {
    for (const period of ['today', '7d', '30d', '90d'] as const) {
      const res = demoRespond<unknown>('GET', `/admin/analytics/overview?period=${period}`);
      expect(res).toEqual(dataset.analytics[period]);
    }
  });

  it('falls back to a sane window when the period is missing or nonsense', () => {
    expect(demoRespond('GET', '/admin/analytics/overview')).toEqual(dataset.analytics['30d']);
    expect(demoRespond('GET', '/admin/analytics/overview?period=fortnight')).toEqual(dataset.analytics['30d']);
  });

  it('serves per-team stats for every team and window', () => {
    for (const team of dataset.teams) {
      for (const period of ['today', '7d', '30d', '90d']) {
        const res = demoRespond<unknown>('GET', `/admin/teams/${team.id}/stats?period=${period}`);
        expect(res).toEqual((dataset.teamStats as Record<string, unknown>)[`${team.id}:${period}`]);
      }
    }
  });

  it('serves the wire envelope, not the bare service return', () => {
    // The route wraps the audit service's array in `{ entries }`; the client unwraps that. A fixture
    // stored in the service's shape would render an empty log with no error anywhere.
    expect(demoRespond<{ entries: unknown[] }>('GET', '/admin/audit?limit=50')).toHaveProperty('entries');
    expect(demoRespond<{ teams: unknown[] }>('GET', '/admin/teams')).toHaveProperty('teams');
  });

  it('hands back the larger audit page when a bigger limit is asked for', () => {
    const small = demoRespond<{ entries: unknown[] }>('GET', '/admin/audit?limit=50');
    const large = demoRespond<{ entries: unknown[] }>('GET', '/admin/audit?limit=200');
    expect(large.entries.length).toBeGreaterThan(small.entries.length);
  });

  it('ignores a trailing slash', () => {
    expect(demoRespond('GET', '/admin/teams/')).toEqual(demoRespond('GET', '/admin/teams'));
  });
});

describe('demo responder — writes', () => {
  // A demo that appears to save and silently forgets is worse than one that says what it is.
  it.each([
    ['POST',   '/admin/teams'],
    ['PATCH',  '/admin/teams/abc'],
    ['PUT',    '/admin/models'],
    ['DELETE', '/admin/models/gpt-4o'],
  ])('refuses %s %s', (method, path) => {
    expect(() => demoRespond(method, path)).toThrow(DemoReadOnlyError);
  });

  it('explains itself and points at the real thing', () => {
    try {
      demoRespond('POST', '/admin/teams');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/read-only demo/i);
      expect((err as DemoReadOnlyError).status).toBe(403);
    }
  });
});

// The guard that would have caught the bug this test file was extended for.
//
// The demo shipped with no fixture for GET /admin/users, so the Admin page rendered an error on the
// published site. The hand-written PATHS list above could not catch it — a list only covers what
// somebody remembered to add. This scans the dashboard's own source for the endpoints it calls and
// requires each one to be either answered or explicitly excused, so a page added later fails here
// rather than on the public demo.
describe('demo responder — every endpoint the dashboard calls', () => {
  // Endpoints that are never GET, so having no read fixture is correct rather than an omission.
  // Each is a mutation: signing in, claiming, rotating, purging, revoking.
  const WRITE_ONLY = new Set([
    '/admin/login', '/admin/logout',
    '/admin/setup/claim', '/admin/setup/reset',
    '/admin/auth/recover', '/admin/auth/recovery-codes',
    '/admin/auth/totp/enrol', '/admin/auth/totp/confirm', '/admin/auth/totp/disable',
    '/admin/me/password', '/admin/me/recovery-key', '/admin/me/sessions/revoke-others',
    '/admin/api-key/regenerate', '/admin/cache/purge',
    '/admin/notifications/read-all', '/admin/invites/accept',
    // "Back up now" — the same machinery the schedule uses, on demand. POST only.
    '/admin/backup/schedule/run',
  ]);

  // Endpoints that never pass through `api()` at all, so `demoRespond` is not on their path and a
  // fixture for them would be code that can never run (B1.4).
  //
  // Backup is the whole set: an export answers with a binary stream, a restore is a multipart upload
  // that reports its own progress through XMLHttpRequest, and the maintenance poll deliberately
  // reads its own response so that a 401 — which a `replace` restore guarantees the moment it wipes
  // every session — cannot be turned into a sign-out. They are also unreachable in the demo twice
  // over: the tab is owner-only and the demo identity is a viewer.
  const OUTSIDE_THE_API_CLIENT = new Set([
    '/admin/backup/export', '/admin/backup/restore', '/admin/backup/maintenance',
  ]);

  // Sources are read with Vite's own `import.meta.glob`, not node:fs. Anything using `process` or
  // `readFileSync` here would be a Node global inside a file tsconfig checks, and `types` is pinned
  // to browser typings on purpose — that mismatch typechecks locally (TypeScript finds @types/node
  // in the ROOT project) and fails in CI, which installs only web/. Keeping the guard browser-only
  // is what stops `process` drifting into a component, so the test bends, not the config.
  it('answers every GET endpoint referenced in the dashboard source', () => {
    const modules = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });

    const paths = new Set<string>();
    for (const [file, source] of Object.entries(modules)) {
      if (/\.test\.tsx?$/.test(file)) continue;   // fixtures in tests are not endpoints the app calls
      for (const m of String(source).matchAll(/'(\/admin\/[a-zA-Z0-9/_.-]*)'/g)) paths.add(m[1]);
    }

    expect(paths.size).toBeGreaterThan(20); // the scan found something; a silent zero would pass vacuously

    const unhandled = [...paths]
      .filter((p) => !WRITE_ONLY.has(p) && !OUTSIDE_THE_API_CLIENT.has(p))
      .filter((p) => {
        try { demoRespond('GET', p); return false; } catch { return true; }
      });

    expect(unhandled).toEqual([]);
  });
});

// Answering is not enough — the answer has to be the RIGHT SHAPE.
//
// /admin/config once returned `{publicUrl, source}` while the Connect page reads `data.baseUrl`.
// demoRespond answered, the coverage test above passed, and the page still broke: the TypeError
// landed mid-render, so Connect sat on its "Loading connection…" frame forever with an empty
// console. These assert the fields whose absence kills a render rather than merely blanking a cell.
describe('demo responder — response shapes', () => {
  const REQUIRED: Array<[string, string[]]> = [
    ['/admin/config',           ['baseUrl', 'baseUrlSource', 'apiKeySet', 'isFirstRun']],
    ['/admin/overview',         ['stats', 'series7d', 'topModels', 'topKeys', 'recentLogs']],
    ['/admin/nexus/overview',   ['summary', 'routing', 'tiers']],
    ['/admin/health/overview',  ['status', 'summary', 'checks', 'ready', 'backend']],
    ['/admin/models',           ['models', 'capabilities']],
    ['/admin/teams',            ['teams']],
    ['/admin/team-keys',        ['keys']],
    ['/admin/users',            ['users', 'roles']],
    ['/admin/audit',            ['entries']],
    ['/admin/notifications',    ['notifications', 'unreadCount']],
  ];

  it.each(REQUIRED)('%s carries the fields its page reads', (path, fields) => {
    const res = demoRespond<Record<string, unknown>>('GET', path);
    for (const f of fields) expect(res, `${path} is missing "${f}"`).toHaveProperty(f);
  });

  // The Connect page derives its snippets from this; a non-string would throw the same way.
  it('serves a usable API base URL', () => {
    const cfg = demoRespond<{ baseUrl: string }>('GET', '/admin/config');
    expect(typeof cfg.baseUrl).toBe('string');
    expect(cfg.baseUrl).toMatch(/^https?:\/\/.+\/v1$/);
  });

  // A demo whose Health page says the gateway is down misrepresents a working product. The fixture
  // is captured from real probes (scripts/demo/buildFixtures.ts takes samples first); if that
  // capture regresses to the empty-ring-buffer default, every check reads "down" and this catches it.
  // The demo is a snapshot of a real Postgres + Redis gateway, so its Storage card must say so. If a
  // rebuild ever captured a standalone gateway the demo would quietly advertise the wrong product.
  it('reports the backend the snapshot was actually taken from', () => {
    const h = demoRespond<{ backend: { db: string; kv: string; durable: boolean } }>('GET', '/admin/health/overview');
    expect(h.backend).toMatchObject({ db: 'postgres', kv: 'redis', durable: true });
  });

  it('shows a healthy gateway on the Health page', () => {
    const h = demoRespond<{ status: string; checks: { id: string; status: string }[] }>('GET', '/admin/health/overview');
    expect(h.status).toBe('healthy');
    for (const c of h.checks) expect(c.status, `check "${c.id}" is ${c.status}`).toBe('healthy');
  });
});

describe('demo responder — gaps', () => {
  // Loud, not silent: an unfixtured path should be obvious in development rather than rendering an
  // empty panel in the published demo.
  it('throws a named error for an unknown path', () => {
    expect(() => demoRespond('GET', '/admin/something-new')).toThrow(DemoUnhandledError);
    expect(() => demoRespond('GET', '/admin/something-new')).toThrow(/no fixture for GET/);
  });

  it('throws for a team that does not exist rather than inventing one', () => {
    expect(() => demoRespond('GET', '/admin/teams/no-such-team/stats')).toThrow(DemoUnhandledError);
  });
});
