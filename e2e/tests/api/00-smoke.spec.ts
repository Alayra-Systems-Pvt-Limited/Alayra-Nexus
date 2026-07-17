import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack, MOCK_PROVIDER_URL } from '../../setup/stacks';

// The harness proves itself before anything else runs: both gateways came up from an
// empty database (fifteen migrations applied by the setup), and the mock provider is
// reachable. If this file fails, no other failure in the run means anything.

const gw = new Gateway(stack('api').baseURL);

test('the api gateway is healthy', async () => {
  const res = await gw.get<{ ok: boolean }>('/health');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('the ui gateway is healthy', async () => {
  const res = await new Gateway(stack('ui').baseURL).get<{ ok: boolean }>('/health');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('the mock provider is reachable and keeps its ledger', async () => {
  const res = await fetch(`${MOCK_PROVIDER_URL}/__requests`);
  expect(res.status).toBe(200);
  const body = await res.json() as { count: number };
  expect(body.count).toBe(0);
});

test('an unauthenticated admin request is refused', async () => {
  const res = await gw.get('/admin/status');
  expect(res.status).toBe(401);
});

test('a doubled /v1/v1 path reaches the same route as /v1', async () => {
  // The footgun this covers: a tool that appends `/v1/models` to a pasted base that already ends
  // in `/v1`. The rewrite must land on the real route — a 401 (key required), never a 404 — and
  // must not fire twice: /v1/v1/v1/... stays the honest 404 it deserves.
  expect((await gw.get('/v1/v1/models')).status).toBe(401);
  expect((await gw.get('/v1/models')).status).toBe(401);
  expect((await gw.get('/v1/v1/v1/models')).status).toBe(404);
});
