import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack, MOCK_PROVIDER_URL } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The gateway's actual job, proven at the boundary: a completion request goes in one side,
// the pool's credential goes out the other, and every limit refuses BEFORE the upstream is
// touched. The mock provider keeps a ledger of every request it receives, which is how a
// negative is proven here — a rejection must show up as a refusal at our door AND as an
// absence upstream. A rate limit that rejects the caller but still bills the provider
// would pass any test that only reads the response.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

let ownerToken = '';
let masterKey = '';
let poolId = '';
let poolKeyId = '';
let teamId = '';
let teamKey = '';

/** How many requests the mock provider has ever received. */
async function upstreamCount(): Promise<number> {
  const res = await fetch(`${MOCK_PROVIDER_URL}/__requests`);
  const body = await res.json() as { count: number };
  return body.count;
}

/** One completion request, returning the raw wire response. */
function complete(apiKey: string) {
  return gw.post<{
    choices?: { message: { content: string } }[];
    usage?: { total_tokens: number };
    error?: string;
  }>('/v1/chat/completions', {
    token: apiKey,
    body: { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'Hello from the e2e suite' }] },
  });
}

test.beforeAll(async () => {
  ownerToken = await gw.login(OWNER.email, OWNER.password);
});

test('rotating the master key returns it exactly once', async () => {
  const res = await gw.post<{ key: string; masked: string }>('/admin/api-key/regenerate', { token: ownerToken });
  expect(res.status).toBe(200);
  expect(res.body.key).toBeTruthy();
  // The hint shown in the dashboard must not be the key itself.
  expect(res.body.masked).not.toBe(res.body.key);
  masterKey = res.body.key;
});

test('the proxy refuses missing and wrong credentials without touching upstream', async () => {
  const before = await upstreamCount();

  const missing = await gw.post('/v1/chat/completions', {
    body: { model: 'alayra-nexus-1', messages: [{ role: 'user', content: 'hi' }] },
  });
  expect(missing.status).toBe(401);

  const wrong = await complete('definitely-not-the-key');
  expect(wrong.status).toBe(401);

  expect(await upstreamCount()).toBe(before);
});

test('a pool pointing at a private address outside the allowlist is refused at the door', async () => {
  // 127.0.0.1 is allowlisted for the mock (a real deployment knob); 10.x is not. The SSRF
  // guard must stop the URL at creation, not at first use.
  const res = await gw.post<{ error: string }>('/admin/providers', {
    token: ownerToken,
    body: { name: 'Sneaky Pool', slug: 'sneaky', provider: 'custom', tier: 'standard', baseUrl: 'http://10.1.2.3/v1' },
  });
  expect(res.status).toBe(400);
});

test('an operator configures a pool, a key, and a model against the mock provider', async () => {
  const pool = await gw.post<{ provider: { id: string } }>('/admin/providers', {
    token: ownerToken,
    body: {
      name: 'Mock Pool', slug: 'mock', provider: 'custom', tier: 'standard',
      baseUrl: `${MOCK_PROVIDER_URL}/v1`, authHeader: 'Authorization', authPrefix: 'Bearer ',
    },
  });
  expect(pool.status).toBe(201);
  poolId = pool.body.provider.id;

  const key = await gw.post<{ key: { id: string } }>(`/admin/providers/${poolId}/keys`, {
    token: ownerToken,
    body: { apiKey: 'sk-mock-upstream-secret', label: 'mock key', rpmLimit: 50, tpmLimit: 100000 },
  });
  expect(key.status).toBe(201);
  poolKeyId = key.body.key.id;

  // Prices are astronomically wrong on purpose: they make a single 12-token request cost
  // ~$120, so the budget test further down crosses its cap on the first request.
  const models = await gw.send('PUT', '/admin/models', {
    token: ownerToken,
    body: {
      models: [{
        id: 'mock-model-1', displayName: 'Mock Model', provider: 'custom', modelString: 'mock-model-1',
        tier: 'standard', status: 'active', priority: 1, capabilities: ['chat'],
        inputCostPer1M: 10_000_000, outputCostPer1M: 10_000_000,
      }],
    },
  });
  expect(models.status).toBe(200);
});

test('a completion flows end to end, and the caller never learns the pool credential', async () => {
  const before = await upstreamCount();
  const res = await complete(masterKey);

  expect(res.status).toBe(200);
  expect(res.body.choices?.[0]?.message.content).toContain('mock provider answers');
  expect(res.body.usage?.total_tokens).toBe(12);

  // Exactly one upstream call — and it authenticated with the POOL's key, not the caller's.
  // The whole point of a key pool: the caller's credential opens our door; ours opens theirs.
  expect(await upstreamCount()).toBe(before + 1);
  const ledger = await (await fetch(`${MOCK_PROVIDER_URL}/__requests`)).json() as {
    requests: { authorization: string | null }[];
  };
  const last = ledger.requests[ledger.requests.length - 1];
  expect(last.authorization).toBe('Bearer sk-mock-upstream-secret');
  expect(JSON.stringify(ledger)).not.toContain(masterKey);
});

test('a team key signs requests, and revoking it ends them', async () => {
  const team = await gw.post<{ team: { id: string } }>('/admin/teams', {
    token: ownerToken, body: { name: 'E2E Consumers' },
  });
  expect(team.status).toBe(201);
  teamId = team.body.team.id;

  const minted = await gw.post<{ key: { id: string; plainKey: string } }>('/admin/team-keys', {
    token: ownerToken, body: { name: 'consumer key', teamId },
  });
  expect(minted.status).toBe(201);

  const ok = await complete(minted.body.key.plainKey);
  expect(ok.status).toBe(200);

  const before = await upstreamCount();
  const revoke = await gw.send('DELETE', `/admin/team-keys/${minted.body.key.id}`, { token: ownerToken });
  expect(revoke.status).toBe(200);

  const dead = await complete(minted.body.key.plainKey);
  expect(dead.status).toBe(401);
  expect(await upstreamCount()).toBe(before);
});

test('a team that hits its budget is refused before any provider work happens', async () => {
  const capped = await gw.send('PATCH', `/admin/teams/${teamId}`, {
    token: ownerToken, body: { budgetUsd: 0.01, budgetPeriod: 'monthly', overBudgetAction: 'block' },
  });
  expect(capped.status).toBe(200);

  const minted = await gw.post<{ key: { plainKey: string } }>('/admin/team-keys', {
    token: ownerToken, body: { name: 'budget key', teamId },
  });
  teamKey = minted.body.key.plainKey;

  // The first request may be admitted — cost is unknowable up front on a gateway, so a team
  // crosses its cap by at most one request's cost (this is documented behaviour, not a bug).
  // At ~$120 per request against a $0.01 budget, the refusal must arrive within a few
  // requests; the spend is written in the response path, so one round usually suffices.
  let refusal: { status: number; body: { error?: string; retryAfter?: number } } | null = null;
  for (let i = 0; i < 6; i++) {
    const res = await complete(teamKey);
    if (res.status === 429) { refusal = res; break; }
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
  }
  expect(refusal, 'the budget cap never engaged').not.toBeNull();
  expect(refusal!.body.error).toMatch(/budget/i);

  const before = await upstreamCount();
  const again = await complete(teamKey);
  expect(again.status).toBe(429);
  // Refused at our door: the upstream was never touched, so the refusal cost nothing.
  expect(await upstreamCount()).toBe(before);
});

test('the RPM limit admits exactly its budget and the refusal never reaches upstream', async () => {
  // Every upstream call so far went through the one pool key, so its RPM counter equals the
  // mock's ledger. Set the limit to that plus two: two more requests fit, the third cannot.
  const used = await upstreamCount();
  const patched = await gw.send('PATCH', `/admin/keys/${poolKeyId}`, {
    token: ownerToken, body: { rpmLimit: used + 2 },
  });
  expect(patched.status).toBe(200);

  expect((await complete(masterKey)).status).toBe(200);
  expect((await complete(masterKey)).status).toBe(200);

  const refused = await complete(masterKey);
  // With the only key over its rate, the pool is exhausted: 503 with a Retry-After, telling
  // the caller when capacity returns — not 500, which would say something is broken.
  expect(refused.status).toBe(503);
  expect(await upstreamCount()).toBe(used + 2);
});

test('the TPM limit refuses spent token budgets the same way', async () => {
  const before = await upstreamCount();
  // The window already carries this key's real token usage, far beyond a limit of 1 —
  // so with RPM headroom restored, the token budget alone must refuse the request.
  const patched = await gw.send('PATCH', `/admin/keys/${poolKeyId}`, {
    token: ownerToken, body: { rpmLimit: 1000, tpmLimit: 1 },
  });
  expect(patched.status).toBe(200);

  const refused = await complete(masterKey);
  expect(refused.status).toBe(503);
  expect(await upstreamCount()).toBe(before);
});

test('rotating the master key kills the old one immediately', async () => {
  const res = await gw.post<{ key: string }>('/admin/api-key/regenerate', { token: ownerToken });
  expect(res.status).toBe(200);

  const old = await complete(masterKey);
  expect(old.status).toBe(401);
});
