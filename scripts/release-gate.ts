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

// ── The release gate ──────────────────────────────────────────────────────────────────────────
//
//   npm run gate:e2e                      against a gateway on http://localhost:3000
//   npm run gate:e2e -- --provider groq   pick the provider (default: groq)
//
// One question, asked end to end against a running gateway and a real provider key:
//
//   can somebody who has just installed Nexus add a provider, get its models, send a request
//   through the OpenAI-compatible endpoint, and see what it cost?
//
// Everything else in the test suite answers a piece of that. Nothing else answers the whole thing,
// and the whole thing is what a user experiences. Each unit along the way is covered by fast tests
// that mock the one next to it; the failures this catches are the ones that live in the seams —
// a harvested price that never reaches the registry, a usage row written under a model id that the
// analytics query groups by differently, a key that validates but cannot serve.
//
// ── The step that is the actual gate ──────────────────────────────────────────────────────────
//
// COST. A request that returns 200 proves routing; it does not prove the product. Nexus exists to
// tell an operator what their AI spend is, and a $0 answer is indistinguishable from cheap. Steps
// 1-6 can all pass while the thing the operator bought is broken, which is exactly the class of
// bug this phase started with: models were being routed to and served from, and every one of them
// reported nothing.
//
// ── Why it is not in `npm test` ───────────────────────────────────────────────────────────────
//
// It needs a live gateway, a live database, and a real provider key, and it writes real rows. It
// is a deliberate pre-release action, run by a human, against something already running.
//
// Credentials come from the environment and are never printed: ADMIN_PASSWORD to reach /admin,
// PROVIDER_KEY_<SLUG> for the pool. The pool it creates is torn down on the way out, including
// after a failure, so a red run does not leave a half-configured gateway behind.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROVIDER_PRESETS, presetFor } from '../src/data/providers';
// Shared with the conformance harness so both scripts pick the same model for a given provider.
import { candidates } from './verify-providers';

const GATEWAY = process.env.GATE_GATEWAY_URL ?? 'http://localhost:3000';
const SLUG    = argOf('--provider') ?? 'groq';
/** Marks everything this script creates, so a leftover from a killed run is obvious and greppable. */
const TAG     = 'release-gate';

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let failures = 0;
/** Set when the run stopped short for a reason that is not a defect — see step 6. */
let skipped: string | null = null;
const step = (n: number, what: string) => console.log(`\n[${n}] ${what}`);
const pass = (detail: string) => console.log(`    PASS  ${detail}`);
function fail(detail: string): void {
  failures++;
  console.log(`    FAIL  ${detail}`);
}

interface Json { [k: string]: unknown }

/** Requests and spend in the current window, read the way the Analytics page reads them. */
async function readTotals(admin: string): Promise<{ requests: number; cost: number }> {
  const res    = await call('/admin/analytics/overview?range=1d', { token: admin });
  const totals = (res.body.totals ?? res.body) as Json;
  return {
    requests: Number(totals.requests ?? 0),
    cost:     Number(totals.cost ?? totals.estimatedUsd ?? totals.totalCost ?? 0),
  };
}

/** The key the gateway wrote at first boot, if the operator still has it. */
function readKeyFile(): string | undefined {
  try {
    return readFileSync(resolve(process.env.NEXUS_DATA_DIR ?? '.nexus', 'api-key.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  } catch { return undefined; }
}

async function call(path: string, init: RequestInit & { token: string }): Promise<{ status: number; body: Json }> {
  const { token, ...rest } = init;
  // content-type only when there IS a body: Fastify rejects a bodiless request that declares a JSON
  // content-type with a 400, which reads as "the gateway refused the delete" rather than "the
  // client sent a malformed request".
  const res = await fetch(`${GATEWAY}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${token}`,
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // A non-JSON body is kept as `raw` rather than swallowed: an HTML error page from a proxy in
  // front of the gateway is the most useful thing on the screen when that happens.
  let body: Json;
  try { body = text ? JSON.parse(text) as Json : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function main() {
  const preset = presetFor(SLUG);
  if (!preset) {
    console.error(`Unknown provider "${SLUG}". Known: ${PROVIDER_PRESETS.map((p) => p.slug).join(', ')}`);
    process.exit(2);
  }

  const admin = process.env.ADMIN_PASSWORD?.trim();
  const key   = process.env[`PROVIDER_KEY_${SLUG.toUpperCase()}`]?.trim();
  if (!admin) { console.error('ADMIN_PASSWORD is not set — this script talks to /admin.'); process.exit(2); }
  if (!key)   { console.error(`PROVIDER_KEY_${SLUG.toUpperCase()} is not set.`); process.exit(2); }

  console.log(`\nRelease gate — ${preset.label} via ${GATEWAY}`);
  let providerId: string | null = null;

  try {
    // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
    step(1, 'The gateway is up');
    const health = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json() as Promise<Json>)
      .catch(() => null);
    if (health?.ok !== true) { fail(`${GATEWAY}/health did not answer ok`); return; }
    pass(`${GATEWAY} is serving`);

    // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
    step(2, 'Create a provider pool from the preset');
    const account = preset.accountPlaceholder
      && process.env[`PROVIDER_ACCOUNT_${SLUG.toUpperCase()}`]?.trim();
    if (preset.accountPlaceholder && !account) {
      fail(`PROVIDER_ACCOUNT_${SLUG.toUpperCase()} is needed for ${preset.label}'s account-scoped URLs`);
      return;
    }
    const fill = (u: string) => (preset.accountPlaceholder && account
      ? u.split(preset.accountPlaceholder.token).join(account) : u);

    // Remove a pool left behind by a killed or failed earlier run. Without this the second run
    // stops at a 409 about its own leftover, which tells the operator nothing about the release.
    const pools = ((await call('/admin/providers', { token: admin })).body.providers ?? []) as Json[];
    for (const p of pools.filter((p) => String(p.slug).startsWith(TAG))) {
      await call(`/admin/providers/${String(p.id)}`, { token: admin, method: 'DELETE' });
      console.log(`    (removed a leftover pool "${String(p.slug)}" from an earlier run)`);
    }

    const created = await call('/admin/providers', {
      token: admin, method: 'POST',
      body: JSON.stringify({
        name: `${preset.label} (${TAG})`, slug: `${TAG}-${SLUG}`, provider: SLUG, tier: 'fast',
        baseUrl: fill(preset.baseUrl),
        ...(preset.modelFetchUrl ? { modelFetchUrl: fill(preset.modelFetchUrl) } : {}),
        authHeader: preset.authHeader, authPrefix: preset.authPrefix,
        modelIdPath: preset.modelIdPath,
        ...(Object.keys(preset.extraHeaders).length ? { extraHeaders: preset.extraHeaders } : {}),
      }),
    });
    const provider = created.body.provider as Json | undefined;
    if (created.status !== 200 && created.status !== 201) {
      fail(`POST /admin/providers → ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
      return;
    }
    providerId = String(provider?.id ?? '');
    if (!providerId) { fail('the pool was created but the response carried no id'); return; }
    pass(`pool created for provider slug "${SLUG}"`);
    // The enum this replaced would have refused mistral, huggingface, cloudflare and cerebras here.
    if (!['openai', 'anthropic', 'google', 'groq', 'openrouter', 'custom'].includes(SLUG)) {
      pass(`"${SLUG}" is outside the old six-value provider enum and was accepted`);
    }

    // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
    step(3, 'Add the real key, with the gateway validating it against the provider');
    const added = await call(`/admin/providers/${providerId}/keys`, {
      token: admin, method: 'POST',
      body: JSON.stringify({ apiKey: key, label: `${TAG}-key`, rpmLimit: 60, tpmLimit: 100_000 }),
    });
    if (added.status !== 200 && added.status !== 201) {
      fail(`POST keys → ${added.status} ${JSON.stringify(added.body).slice(0, 300)}`);
      return;
    }
    pass('key accepted and validated upstream');

    // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
    step(4, 'Fetch the model list through the gateway');
    const fetched = await call(`/admin/providers/${providerId}/fetch-models`, {
      token: admin, method: 'POST', body: JSON.stringify({}),
    });
    const models = (fetched.body.models ?? []) as { id: string; inputCostPer1M?: number; outputCostPer1M?: number }[];
    if (fetched.status !== 200 || !models.length) {
      fail(`fetch-models → ${fetched.status} ${JSON.stringify(fetched.body).slice(0, 300)}`);
      return;
    }
    pass(`${models.length} models via "${preset.modelIdPath}"`);

    // PER MODEL, not across the list. This is the same test web/src/lib/registry.ts makes when the
    // dashboard saves a fetched model, and the distinction is not academic: Groq publishes prices
    // for most of its catalogue and `pricing: null` for the rest (allam-2-7b, groq/compound-mini,
    // the Whisper models). Reading "some model had a price" as "this model has a price" stamps
    // `harvested` on a model whose cost is unknown — which is precisely the bug that made unpriced
    // models look free.
    const hasPrice = (m: { inputCostPer1M?: number; outputCostPer1M?: number }) =>
      m.inputCostPer1M !== undefined || m.outputCostPer1M !== undefined;

    const withPrice    = models.filter(hasPrice);
    const withoutPrice = models.filter((m) => !hasPrice(m));

    if (preset.publishesPricing && !withPrice.length) {
      fail(`the preset says ${preset.label} publishes prices, but none arrived — every model would save unpriced`);
    } else if (withPrice.length) {
      pass(`${withPrice.length} of ${models.length} models arrived with a published price`);
    } else {
      pass('no prices published (as the preset says) — models will be flagged unpriced, which is correct');
    }

    // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
    step(5, 'Save models into the registry and check each one\'s provenance');
    // Deliberately one of each where the provider offers both. A provider with mixed pricing is the
    // only place the two states can be told apart in one run, and the failure this guards against
    // is exactly a priced and an unpriced model being treated the same.
    //
    // Both picks go through the same filter. Applying it only to the priced half is how the
    // Cloudflare run came to route a speech model: Cloudflare publishes no prices at all, so the
    // priced half was empty, the unpriced pick was the raw first entry, and the first entry in its
    // catalogue is @cf/pipecat-ai/smart-turn-v2. The 400 that came back was about a missing `audio`
    // field — a true error to a question the gate should never have asked.
    // Ordered by the SAME rule the conformance harness uses, so the two scripts cannot disagree
    // about which model represents a provider. It also protects the gate from a provider whose
    // catalogue advertises models the account cannot use: Google lists 59 and most answer 404 with
    // "no longer available to new users", so taking the first one made the gate red for a reason
    // that has nothing to do with the release.
    const pick = (list: typeof models) => {
      const best = candidates(SLUG, list)[0];
      return list.find((m) => m.id === best) ?? list[0];
    };

    const priceds  = pick(withPrice);
    const unpriced = pick(withoutPrice);

    const before   = await call('/admin/models', { token: admin });
    const existing = ((before.body.models ?? []) as Json[]).filter((m) => m.provider !== SLUG);

    // Stamped exactly as web/src/lib/registry.ts stamps it: `harvested` when THIS model came with a
    // price, `unset` when it did not. Inventing a different value here would test a path no user takes.
    const entryFor = (m: typeof models[number], suffix: string): Json => ({
      id: `${TAG}-${suffix}`, displayName: `${TAG} ${m.id}`, provider: SLUG,
      modelString: m.id, tier: 'fast', status: 'active', priority: 1, capabilities: ['chat'],
      inputCostPer1M: m.inputCostPer1M ?? 0, outputCostPer1M: m.outputCostPer1M ?? 0,
      pricingSource: hasPrice(m) ? 'harvested' : 'unset',
    });

    const entries = [
      ...(priceds  ? [entryFor(priceds,  'priced')]   : []),
      ...(unpriced ? [entryFor(unpriced, 'unpriced')] : []),
    ];
    if (!entries.length) { fail('the provider returned no models to save'); return; }

    const saved = await call('/admin/models', {
      token: admin, method: 'PUT', body: JSON.stringify({ models: [...existing, ...entries] }),
    });
    if (saved.status !== 200) {
      fail(`PUT /admin/models → ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
      return;
    }

    // The PUT answers `{ success: true }`, so read the registry back. That is the stronger check
    // anyway: it proves what the gateway will actually SERVE, not what it echoed.
    const after = ((await call('/admin/models', { token: admin })).body.models ?? []) as Json[];
    for (const entry of entries) {
      const stored = after.find((m) => m.id === entry.id);
      if (!stored) { fail(`"${String(entry.modelString)}" is not in the registry the gateway answered with`); continue; }

      const source    = String(stored.pricingSource);
      const published = entry.pricingSource === 'harvested';

      // Against PUBLISHED, not against "greater than zero". Those are different questions, and
      // conflating them is the original bug wearing a different hat: OpenRouter's `:free` models
      // publish `prompt: "0"`, which is a known price of nothing — not an unknown one. An earlier
      // version of this check read a published zero as "no price" and failed the gate for a model
      // the gateway had handled perfectly.
      if (source !== entry.pricingSource) {
        fail(`"${String(entry.modelString)}" saved as "${String(entry.pricingSource)}" and read back `
          + `as "${source}" — provenance does not survive a round trip, so the dashboard and the `
          + 'router disagree about whether this model has a known cost');
      } else if (published && source === 'unset') {
        fail(`"${String(entry.modelString)}" has a published price but came back "unset" — it would `
          + 'rank first under cost routing and wear a "No price" badge');
      } else if (!published && source !== 'unset') {
        fail(`"${String(entry.modelString)}" has no published price but came back "${source}" — an `
          + 'unknown cost treated as a known zero is what makes analytics silently under-report');
      } else {
        const free = published && Number(stored.inputCostPer1M ?? 0) === 0 && Number(stored.outputCostPer1M ?? 0) === 0;
        pass(`"${String(entry.modelString)}" → pricingSource "${source}"${free ? ' (a published zero — free, not unknown)' : ''} survived the round trip`);
      }
    }
    if (!unpriced) {
      console.log(`    note: ${preset.label} priced every model it returned, so the unpriced half of `
        + 'this check did not run');
    }
    // Everything below routes through the PRICED model: a $0 total is only meaningful as a failure
    // when the model was supposed to cost something.
    const target = priceds ?? unpriced;
    // Three states, not two, and step 7 needs all three to judge a $0 total:
    //   costs money   — a $0 total is a BUG (the request was billable and we recorded nothing)
    //   published 0   — a $0 total is CORRECT (the model is genuinely free)
    //   unpublished   — a $0 total is EXPECTED and flagged in the dashboard as unpriced
    const costsMoney = (target.inputCostPer1M ?? 0) > 0 || (target.outputCostPer1M ?? 0) > 0;
    const freeByPrice = hasPrice(target) && !costsMoney;

    // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
    step(6, 'Send a real request through the OpenAI-compatible endpoint');
    // Baseline taken BEFORE the request, because step 7 must measure what THIS run produced. The
    // first version read the window total, so a second run inherited the first run's cost and would
    // have reported a pass for a request that recorded nothing — the exact false green a release
    // gate exists to prevent.
    const baseline = await readTotals(admin);
    // GET /admin/api-key deliberately answers with a hint and never the credential — the gateway
    // hands the key over exactly once, at first boot, into .nexus/api-key.txt. Reading it here is
    // not a workaround; it is the same step the Connect tab tells a new operator to take.
    let apiKey = process.env.NEXUS_API_KEY?.trim() || readKeyFile();

    // Opt-in, never automatic. Rotating invalidates every client already pointed at this gateway,
    // so it must be a thing the operator asked for — but a gate that cannot run because a key file
    // was lost is a gate nobody runs, and the file is genuinely easy to lose (it is meant to be
    // read once and deleted).
    if (!apiKey && process.argv.includes('--rotate-key')) {
      const rotated = await call('/admin/api-key/regenerate', { token: admin, method: 'POST', body: '{}' });
      apiKey = (rotated.body.key as string | undefined)?.trim();
      if (apiKey) console.log('    (minted a new gateway API key — any client using the old one must be updated)');
    }

    if (!apiKey) {
      fail('no gateway API key. Set NEXUS_API_KEY, or point NEXUS_DATA_DIR at the directory holding '
        + 'api-key.txt, or re-run with --rotate-key to mint one (which invalidates existing clients)');
      return;
    }

    const started = Date.now();
    const chat = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: target.id, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(60_000),
    });
    const chatBody = await chat.json().catch(() => ({})) as Json;
    if (!chat.ok) {
      const detail = `POST /v1/chat/completions → ${chat.status} ${JSON.stringify(chatBody).slice(0, 300)}`;
      // A provider the preset has never claimed serves chat is not a regression in Nexus. Cerebras
      // is the standing case: its catalogue works on a free key and every completion is a 402 until
      // the account is funded. Reporting that as a gate failure would make this script permanently
      // red for a reason src/data/providers.ts already states out loud — and a gate that is always
      // red is a gate nobody reads.
      if (preset.verified !== 'chat') {
        skipped = `${preset.label} could not serve a completion`;
        console.log(`    SKIP  ${preset.label} is recorded as models-only, and chat did not work: ${detail}`);
        console.log(`          Everything up to this point passed. Re-run once ${preset.label} can serve.`);
        return;
      }
      fail(detail);
      return;
    }
    const usage = chatBody.usage as { total_tokens?: number } | undefined;
    if (!usage?.total_tokens) {
      fail('the completion carried no usage — with no token counts there is no cost to record');
    } else {
      pass(`served in ${Date.now() - started}ms, ${usage.total_tokens} tokens`);
    }

    // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
    step(7, 'The request shows up in analytics WITH A COST — the gate');
    // Usage is written on the response path, so it lands shortly AFTER the completion returns.
    // Polled rather than slept: a single fixed wait is a race, and it lost one run in seven during
    // a back-to-back sweep — reporting "the call was served but never recorded" for a row that
    // arrived a moment later. An intermittently red release gate is one nobody trusts, so the wait
    // ends when the row appears, not when a guessed interval expires.
    let now = baseline;
    for (let waited = 0; waited < 20_000 && now.requests === baseline.requests; waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
      now = await readTotals(admin);
    }
    const requests = now.requests - baseline.requests;
    const cost     = now.cost - baseline.cost;

    if (requests < 1) {
      fail(`analytics recorded ${requests} new request(s) — the call was served but never written`);
    } else if (costsMoney && cost <= 0) {
      fail(`analytics attributed $${cost.toFixed(6)} to a request served by a BILLABLE model `
        + `("${target.id}") — this is the bug the unpriced work exists to prevent, and it is back`);
    } else if (freeByPrice) {
      pass(`${requests} new request(s) recorded, $${cost.toFixed(6)} — "${target.id}" publishes a `
        + 'price of zero, so $0 is the correct total, not a missing one');
    } else if (!costsMoney) {
      // Not a failure, and worth saying plainly: $0 is the honest answer for a model nobody has
      // priced, and the dashboard flags it rather than presenting it as free.
      pass(`${requests} new request(s) recorded, $${cost.toFixed(6)} — "${target.id}" has no `
        + 'published price, and is flagged unpriced rather than treated as free');
    } else {
      pass(`${requests} new request(s) recorded, $${cost.toFixed(6)} attributed to "${target.id}"`);
    }
  } finally {
    if (providerId) {
      // Deleting the pool cascades to its keys; the registry entry is removed with it.
      const gone = await call(`/admin/providers/${providerId}`, { token: admin, method: 'DELETE' });
      console.log(`\n    cleanup: pool ${gone.status === 200 ? 'removed' : `NOT removed (HTTP ${gone.status}) — slug "${TAG}-${SLUG}"`}`);
    }
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.log(`\nGATE FAILED — ${failures} check(s) did not hold.\n`);
    } else if (skipped) {
      // Deliberately NOT "gate passed". Configuration is proven, routing is not, and claiming
      // otherwise would put a sentence in the terminal that the run did not earn.
      console.log(`\nGATE INCOMPLETE — configuration is proven end to end, but ${skipped}, so `
        + 'routing and cost were not exercised.\n');
    } else {
      console.log('\nGATE PASSED — a new install can add this provider, route to it, and see the cost.\n');
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => { console.error('\n', err); process.exit(1); });
