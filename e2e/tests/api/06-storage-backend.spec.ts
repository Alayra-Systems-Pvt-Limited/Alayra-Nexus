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

import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The storage backend the gateway reports (S0), asserted against a REAL compiled server over real
// HTTP — not a unit test's return value and not the demo's frozen snapshot.
//
// This spec exists because of a gap in how the feature was first verified. The Storage card was
// confirmed by loading the static demo, which renders a captured payload: that proves the component
// draws the card, and proves nothing at all about whether a running gateway emits one. Two different
// claims. This closes the link between them, permanently, so it cannot quietly rot.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

interface BackendInfo {
  mode: 'server' | 'standalone';
  db: 'postgres' | 'sqlite';
  kv: 'redis' | 'memory';
  dbLabel: string;
  kvLabel: string;
  durable: boolean;
  summary: string;
  warning: string | null;
}

let token = '';

test.beforeAll(async () => {
  token = await gw.login(OWNER.email, OWNER.password);
});

test('the gateway names the stores it is actually running on', async () => {
  const res = await gw.get<{ backend: BackendInfo }>('/admin/health/overview', token);
  expect(res.status).toBe(200);

  const b = res.body.backend;
  expect(b, 'the overview must carry a backend block').toBeTruthy();

  // The e2e stack is a real PostgreSQL and a real Redis, so this is the answer the gateway owes —
  // and a hardcoded pair would pass a weaker assertion, so the labels and the derived fields are
  // checked too.
  expect(b.mode).toBe('server');
  expect(b.db).toBe('postgres');
  expect(b.kv).toBe('redis');
  expect(b.dbLabel).toBe('PostgreSQL');
  expect(b.kvLabel).toBe('Redis');
  expect(b.durable).toBe(true);
  expect(b.summary).toBe('PostgreSQL + Redis');
  // Nothing about this configuration deserves a caution, and inventing one would train operators to
  // ignore the field on the deployments where it matters.
  expect(b.warning).toBeNull();
});

test('the storage backend is admin-only — the public probes never disclose it', async () => {
  // "This gateway keeps its rate-limit windows in memory and runs a single process" is a useful
  // thing to know before attacking it. /health and /ready are unauthenticated, so they must stay
  // exactly what they were: liveness and a check list, no infrastructure detail.
  const health = await gw.get<Record<string, unknown>>('/health');
  expect(health.status).toBe(200);
  expect(health.body).not.toHaveProperty('backend');
  expect(Object.keys(health.body).sort()).toEqual(['ok', 'ts']);

  // /ready does name its dependencies ("Redis PING", "Postgres SELECT 1") and always has — an
  // orchestrator reading a 503 needs to know WHICH check failed, and those labels are static strings
  // describing the probe. What must not appear is the S0 block: the mode, the durability flag, and
  // the caution that together describe how this deployment is configured.
  //
  // Note for S1: those labels are hardcoded. Once the KV can be in-process memory, a standalone
  // gateway would report "Redis PING" about a Redis it does not have. They must become mode-aware
  // at the same time as the Health page's dependency cards.
  const ready = await gw.get<Record<string, unknown>>('/ready');
  expect(ready.body).not.toHaveProperty('backend');
  expect(Object.keys(ready.body).sort()).toEqual(['checks', 'ready', 'status', 'ts']);
  expect(JSON.stringify(ready.body)).not.toMatch(/standalone|in-process|durable/i);
});

test('an unauthenticated caller cannot read the storage backend', async () => {
  const res = await gw.get('/admin/health/overview');
  expect(res.status).toBe(401);
});
