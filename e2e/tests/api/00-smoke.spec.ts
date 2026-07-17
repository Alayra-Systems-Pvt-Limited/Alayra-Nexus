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
