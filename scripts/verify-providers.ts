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

// ── Provider conformance harness ──────────────────────────────────────────────────────────────
//
//   npm run verify:providers            every provider with a key in .env
//   npm run verify:providers -- groq    just one
//
// ── What this is for ──────────────────────────────────────────────────────────────────────────
//
// src/data/providers.ts makes claims: this base URL, this model-id path, this provider publishes
// prices, this one was seen to serve a real completion. Claims rot. A provider moves an endpoint,
// changes a response shape, starts or stops publishing pricing, or begins requiring a paid plan —
// and nothing in the test suite notices, because a unit test asserting our own table against
// itself passes forever. This is the only thing in the repository that can tell us the table has
// gone stale, and it is the evidence behind any "verified providers" claim we make in public.
//
// ── Why it is not part of `npm test` ──────────────────────────────────────────────────────────
//
// It needs live credentials and it spends real money (a few tokens, but not zero). A test suite
// that needs secrets is a test suite most contributors cannot run, and one that fails when a
// provider has an outage is a test suite people learn to ignore. So: opt-in, run deliberately,
// with the result committed as dated evidence rather than re-earned on every push.
//
// ── Why it goes through the gateway's own code ────────────────────────────────────────────────
//
// The model list is parsed with extractModelMeta and the auth header is built with
// providerAuthHeader — the same functions the proxy uses. A harness with its own private parser
// could pass while Nexus itself failed on the same provider, which would make it worse than
// nothing: it would be a green light for a broken path.
//
// ── What it will not do ───────────────────────────────────────────────────────────────────────
//
// It never edits src/data/providers.ts. It reports drift and exits non-zero; a human decides
// whether the table or the world is wrong. Auto-promoting `verified` from a script would mean the
// claim on the README ultimately came from a transient network result nobody read.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { PROVIDER_PRESETS, type ProviderPreset } from '../src/data/providers';
import { extractModelMeta, type FetchedModel } from '../src/lib/modelPath';
import { providerAuthHeader } from '../src/lib/providerHeaders';
import { stripTrailingSlash } from '../src/lib/url';

const TIMEOUT_MS = 25_000;

/**
 * Models to try first, per provider, cheapest and smallest known.
 *
 * A PREFERENCE, not a requirement: whatever is picked must be in the list the provider actually
 * returned. An earlier version of this probe fell through to `preferred[0]` when nothing matched,
 * and reported Cerebras as 404-on-chat — the truth was that it had been asked for a model Cerebras
 * does not host. A harness that can report a wrong reason is worse than one that reports nothing,
 * because the wrong reason gets written down.
 */
const PREFERRED: Record<string, string[]> = {
  groq:        ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
  openrouter:  ['inclusionai/ling-3.0-tiny:free', 'meta-llama/llama-3.2-3b-instruct:free'],
  mistral:     ['mistral-small-latest', 'ministral-3b-latest'],
  huggingface: ['deepseek-ai/DeepSeek-V4-Flash-0731'],
  // Google lists ids as `models/gemini-…` and accepts either form, which the tail match below
  // handles. Most of what it lists is closed to new accounts (404) or over quota on the free tier
  // (429) — neither is a conformance failure, so the order here leads with what actually serves.
  google:      ['gemini-flash-lite-latest', 'gemini-flash-latest'],
  cloudflare:  ['@cf/meta/llama-3.2-3b-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8'],
  cerebras:    ['gpt-oss-120b', 'gemma-4-31b'],
  openai:      ['gpt-4o-mini'],
  anthropic:   ['claude-haiku-4-5', 'claude-3-5-haiku-20241022'],
};

/**
 * Ids that are plainly not chat models, so a chat probe against them proves nothing.
 *
 * Cloudflare is why this exists: its catalogue is every task type in one list, and the first entry
 * is a speech model. Sending that to /chat/completions returns a 400 about a missing `audio` field
 * — a real error about the wrong question, which the first run of this harness duly recorded as
 * "Cloudflare does not do chat".
 */
export const NOT_CHAT = /(^|[-/@_])(embed|embedding|bge|rerank|whisper|tts|stt|speech|audio|voice|turn|image|img|sdxl|dreamshaper|diffusion|flux|vision-encoder|guard|moderat|translat|summar|resnet|detr|classif)/i;

/** How many models to try before concluding the provider will not serve a completion. */
const MAX_CHAT_ATTEMPTS = 4;

const tail = (id: string) => id.slice(id.lastIndexOf('/') + 1);

/**
 * Which models to attempt, best first.
 *
 * Preferences match on the whole id OR on the segment after the last slash, so a provider that
 * namespaces its listing (Google's `models/…`) does not read as "none of the preferred models
 * exist". Anything left over comes from the provider's own list, minus the obviously-not-chat
 * entries — because a preference list is a snapshot, and providers retire models. Cloudflare had
 * dropped `@cf/meta/llama-3.1-8b-instruct-fast` between one run of this script and the next.
 */
export function candidates(slug: string, models: FetchedModel[]): string[] {
  const ids  = models.map((m) => m.id);
  const want = PREFERRED[slug] ?? [];
  const hits = want.flatMap((w) => ids.filter((id) => id === w || tail(id) === tail(w)));
  const rest = ids.filter((id) => !hits.includes(id) && !NOT_CHAT.test(id));
  return [...new Set([...hits, ...rest])].slice(0, MAX_CHAT_ATTEMPTS);
}

export type Status = 'chat' | 'models' | 'unreachable' | 'skipped';

export interface Result {
  slug: string;
  label: string;
  status: Status;
  claimed: ProviderPreset['verified'];
  /** True when the measurement contradicts what src/data/providers.ts claims. */
  drift: boolean;
  modelsUrl?: string;
  modelCount?: number;
  sampleIds?: string[];
  /** Did the LIST response carry prices? This is what `publishesPricing` asserts. */
  pricingPublished?: boolean;
  pricingClaimed?: boolean;
  chatModel?: string;
  /** What the provider echoed back — HuggingFace answers with a different id than it was asked. */
  chatModelEchoed?: string;
  /** Every model tried and what it answered. The reason a failure is readable a month later. */
  chatAttempts?: { model: string; ok: boolean; error?: string }[];
  usage?: Record<string, unknown>;
  notes: string[];
  error?: string;
}

/** The env var holding this provider's key. Absent → the provider is skipped, not failed. */
const keyFor = (slug: string) => process.env[`PROVIDER_KEY_${slug.toUpperCase()}`]?.trim();

/**
 * Fill an account placeholder from the environment.
 *
 * Cloudflare's URLs are account-scoped, so without PROVIDER_ACCOUNT_CLOUDFLARE there is no URL to
 * call at all — reported as a skip with a reason rather than a failure, because a missing local
 * value says nothing about Cloudflare.
 */
export function resolveUrls(preset: ProviderPreset): { base: string; models: string; missing?: string } {
  const base   = stripTrailingSlash(preset.baseUrl);
  const models = preset.modelFetchUrl ?? (base ? `${base}/models` : '');
  const ph     = preset.accountPlaceholder;
  if (!ph) return { base, models };

  const account = process.env[`PROVIDER_ACCOUNT_${preset.slug.toUpperCase()}`]?.trim();
  if (!account) return { base, models, missing: `PROVIDER_ACCOUNT_${preset.slug.toUpperCase()}` };
  return { base: base.split(ph.token).join(account), models: models.split(ph.token).join(account) };
}

/**
 * Strip local identifiers out of anything destined for the committed record.
 *
 * Provider error bodies quote the URL they were called on, so an account-scoped provider leaks the
 * account id through its own 404 text even when the URL field itself is generic.
 */
export function redact(text: string): string {
  let out = text;
  for (const preset of PROVIDER_PRESETS) {
    const ph = preset.accountPlaceholder;
    const value = ph && process.env[`PROVIDER_ACCOUNT_${preset.slug.toUpperCase()}`]?.trim();
    if (ph && value) out = out.split(value).join(ph.token);
  }
  return out;
}

const authHeaders = (preset: ProviderPreset, key: string): Record<string, string> => ({
  ...preset.extraHeaders,
  ...providerAuthHeader(preset.authHeader, preset.authPrefix, key),
});

async function listModels(preset: ProviderPreset, key: string, url: string) {
  const res  = await fetch(url, { headers: authHeaders(preset, key), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);

  let json: unknown;
  try { json = JSON.parse(body); }
  catch { throw new Error(`${url} did not answer JSON`); }

  const models = extractModelMeta(json, preset.modelIdPath);
  if (!models.length) throw new Error(`no ids at "${preset.modelIdPath}" in the response from ${url}`);
  return models;
}

/** One completion, one token. Enough to prove the credential, the URL and the body shape. */
async function probeChat(preset: ProviderPreset, key: string, base: string, model: string) {
  const res = await fetch(`${base}/chat/completions`, {
    method:  'POST',
    headers: { ...authHeaders(preset, key), 'content-type': 'application/json' },
    body:    JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);

  const json = JSON.parse(body) as { model?: string; usage?: Record<string, unknown> };
  return { echoed: json.model, usage: json.usage };
}

async function verify(preset: ProviderPreset): Promise<Result> {
  const base: Result = {
    slug: preset.slug, label: preset.label, status: 'skipped',
    claimed: preset.verified, drift: false,
    pricingClaimed: preset.publishesPricing, notes: [],
  };

  const key = keyFor(preset.slug);
  if (!key) {
    base.notes.push(`no PROVIDER_KEY_${preset.slug.toUpperCase()} in the environment`);
    return base;
  }

  const urls = resolveUrls(preset);
  if (urls.missing) {
    base.notes.push(`${urls.missing} is not set, and this provider's URLs are account-scoped`);
    return base;
  }
  // Recorded with the placeholder put BACK. This file is committed as public evidence, and an
  // account-scoped URL carries the operator's account id — not a credential, but not something to
  // publish on their behalf either. The probe still calls the resolved URL; only the record is
  // generic, which also makes two operators' runs diffable.
  base.modelsUrl = preset.accountPlaceholder
    ? preset.modelFetchUrl ?? `${stripTrailingSlash(preset.baseUrl)}/models`
    : urls.models;

  let models: FetchedModel[];
  try {
    models = await listModels(preset, key, urls.models);
  } catch (err) {
    base.status = 'unreachable';
    // Errors quote the URL that was called, so they need the same redaction as modelsUrl.
    base.error  = redact(err instanceof Error ? err.message : String(err));
    // Claiming anything at all while the model list is unreachable is drift worth a red light.
    base.drift  = preset.verified !== null;
    return base;
  }

  base.status      = 'models';
  base.modelCount  = models.length;
  base.sampleIds   = models.slice(0, 3).map((m) => m.id);
  // The claim `publishesPricing` makes is about the LIST response, which is the only place the
  // harvester can read a price from. A provider with a price page and no price in its API
  // publishes nothing as far as Nexus is concerned.
  base.pricingPublished = models.some((m) => m.inputCostPer1M !== undefined || m.outputCostPer1M !== undefined);
  if (base.pricingPublished !== preset.publishesPricing) {
    base.drift = true;
    base.notes.push(preset.publishesPricing
      ? 'preset says this provider publishes prices, but none came back in the model list'
      : 'this provider now publishes prices — the preset says it does not, so models are being '
        + 'left unpriced that could be priced automatically');
  }

  const attempts = candidates(preset.slug, models);
  base.chatAttempts = [];
  for (const model of attempts) {
    try {
      const { echoed, usage } = await probeChat(preset, key, urls.base, model);
      base.status          = 'chat';
      base.chatModel       = model;
      base.chatModelEchoed = echoed;
      base.usage           = usage;
      base.chatAttempts.push({ model, ok: true });

      if (!usage) {
        base.notes.push('the completion returned no `usage` block — token counts and therefore '
          + 'cost cannot be recorded for this provider');
      }
      if (echoed && echoed !== model) {
        base.notes.push(`asked for "${model}" and the response names "${echoed}" — this provider `
          + 'routes to a host of its choosing, so the model that ran is not the model configured');
      }
      break;
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      base.chatAttempts.push({ model, ok: false, error: message });
      base.error = message;
    }
  }

  if (base.status !== 'chat') {
    base.notes.push(`the model list works; ${attempts.length} completion attempt(s) did not — `
      + 'see chatAttempts for what each model answered');
  }

  // Chat-verified in the table but not chat-verified here — the claim no longer holds.
  if (preset.verified === 'chat' && base.status !== 'chat') base.drift = true;
  return base;
}

const ICON: Record<Status, string> = { chat: 'OK  ', models: 'LIST', unreachable: 'FAIL', skipped: 'skip' };

/**
 * May this run replace the committed evidence for today?
 *
 * The filename is the date, so a second run on the same day overwrites the first. That is correct
 * for two full runs and destructive for anything else — and both destructive cases are one command
 * away:
 *
 *   `verify:providers groq` probes one provider and drops the other eight from the file. The day's
 *   full record is gone, and the loss is invisible: the file still parses, still looks
 *   authoritative, and now simply says nothing about Cloudflare.
 *
 *   A run with no keys marks every provider `skipped`, which reads as "none of this is verified".
 *   Someone with an empty .env could regenerate the public provider table into claiming nothing
 *   works, having measured nothing.
 *
 * A record is a full snapshot or it is not a record. Re-verifying one provider is a legitimate
 * thing to want, so the probe still runs and still prints — it just does not overwrite evidence it
 * did not gather.
 */
export function shouldWriteRecord(only: string[], measuredCount: number): { write: boolean; reason?: string } {
  if (only.length) {
    return { write: false, reason: 'a filtered run is not a snapshot, and would replace today\'s '
      + 'full record with just these providers. Run with no arguments to write the record.' };
  }
  if (measuredCount === 0) {
    return { write: false, reason: 'nothing was measured — no PROVIDER_KEY_* in the environment. A '
      + 'record of all-skipped is not evidence, and would erase a day that had some.' };
  }
  return { write: true };
}

async function main() {
  const only     = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets  = PROVIDER_PRESETS.filter((p) => p.slug !== 'custom' && (!only.length || only.includes(p.slug)));
  if (!targets.length) {
    console.error(`No preset matches ${only.join(', ')}. Known: ${PROVIDER_PRESETS.map((p) => p.slug).join(', ')}`);
    process.exit(2);
  }

  console.log(`\nProvider conformance — ${targets.length} preset(s)\n`);
  const results: Result[] = [];
  // Sequential on purpose: a provider that rate-limits is a provider that reports a false failure,
  // and the whole point of this script is that its output can be trusted without re-running it.
  for (const preset of targets) {
    const r = await verify(preset);
    results.push(r);
    const detail = r.status === 'skipped' ? r.notes[0]
      : r.status === 'unreachable' ? r.error
      : `${r.modelCount} models${r.chatModel ? `, chat via ${r.chatModel}` : ''}${r.pricingPublished ? ', publishes pricing' : ''}`;
    console.log(`  ${ICON[r.status]}  ${r.label.padEnd(24)} ${detail}`);
    for (const n of r.notes.slice(r.status === 'skipped' ? 1 : 0)) console.log(`        ↳ ${n}`);
    if (r.drift) console.log('        ↳ DRIFT: this contradicts src/data/providers.ts');
  }

  const measured = results.filter((r) => r.status !== 'skipped');
  const chat     = measured.filter((r) => r.status === 'chat');
  const drifted  = results.filter((r) => r.drift);

  console.log(`\n  ${chat.length}/${measured.length} measured providers served a real completion.`);

  const decision = shouldWriteRecord(only, measured.length);
  if (!decision.write) {
    console.log(`  Not written: ${decision.reason}\n`);
  } else {
    // Written even when something drifted: the record of a bad day is the useful one.
    const stamp = new Date().toISOString();
    const out   = resolve(__dirname, `../docs/provider-verification/${stamp.slice(0, 10)}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({
      generatedAt: stamp,
      note: 'Produced by `npm run verify:providers` against live provider APIs. Never edited by hand.',
      summary: { measured: measured.length, chatVerified: chat.length, drifted: drifted.length },
      results,
    }, null, 2)}\n`);
    console.log(`  Written to ${out}`);
    console.log('  Now run `npm run docs:providers` to bring the README table in line.\n');
  }

  if (drifted.length) {
    console.error(`  ${drifted.length} provider(s) no longer match src/data/providers.ts: `
      + `${drifted.map((d) => d.slug).join(', ')}\n`);
    process.exit(1);
  }
}

// Guarded so the pure helpers above can be unit-tested. Without this, importing this file to test
// `candidates()` would start calling provider APIs — a test suite that spends money and fails when
// somebody else's service is down.
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
