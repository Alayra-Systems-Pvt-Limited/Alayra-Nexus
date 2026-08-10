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

// ── Provider presets ──────────────────────────────────────────────────────────────────────────
//
// Everything Nexus knows about a provider before an operator types anything, in ONE table.
//
// ── Why one table ─────────────────────────────────────────────────────────────────────────────
//
// This started as four: a base-URL switch in nexus.service.ts, a defaults map in the dashboard's
// add-provider dialog, a key-prefix map in lib/keyPrefix.ts, and the provider column of the pricing
// catalog. Each knew a different subset of providers. The dialog could seed a Mistral pool the
// routing layer had no default URL for; the key-prefix map knew `hf_` for a HuggingFace pool the
// dialog could not offer. Adding a provider meant finding all four, and missing one produced a
// pool that looked configured and behaved wrongly.
//
// ── Presets are defaults, not a whitelist ─────────────────────────────────────────────────────
//
// A provider slug is free text (schema.prisma: `provider String`). Nothing here restricts what an
// operator may run — a pool pointed at a local llama.cpp, a corporate proxy or another Nexus is a
// first-class pool with no entry in this file. Absence from this table costs exactly one thing:
// the fields are not pre-filled. Nothing downstream branches on the slug, because the transport is
// generic (base URL + auth header + auth prefix + extra headers + model-id path) — which is the
// property that makes the whole table safe to be advisory.
//
// ── Where these values come from ──────────────────────────────────────────────────────────────
//
// `verified` records what was actually measured against a live key on 2026-08-10, not what the
// vendor's documentation claims:
//
//   'chat'   — /models listed, a real completion returned, and usage came back on the response.
//   'models' — the model list works; a completion was not obtained (see `note`).
//   null     — never probed here. Not a claim of brokenness, just an absence of evidence.
//
// `npm run verify:providers` re-runs those probes against whatever keys are present and reports
// where reality has drifted from this table. Nothing may be promoted to 'chat' by hand.

export interface ProviderPreset {
  /** Upstream provider id. Free text in the database; this is the pre-filled set. */
  slug: string;
  /** How to name it to a human — errors, dropdowns, docs. */
  label: string;
  /** OpenAI-compatible base. Empty for `custom`, which by definition has no default. */
  baseUrl: string;
  authHeader: string;
  /** Empty string is meaningful: Anthropic sends the raw key with no scheme. */
  authPrefix: string;
  /**
   * Where the model list lives, when it is NOT `baseUrl + /models`.
   *
   * Cloudflare is the reason this exists as its own field rather than an assumption: its
   * OpenAI-compatible base answers /models with 405, and the catalogue is a different endpoint
   * outside the /ai/v1 prefix entirely.
   */
  modelFetchUrl?: string;
  /** Where ids sit in the list response. Cloudflare answers `result[].name`, not `data[].id`. */
  modelIdPath: string;
  extraHeaders: Record<string, string>;
  /**
   * Prefixes that identify this issuer beyond reasonable doubt, for the paste-the-wrong-key check.
   *
   * Empty means "no reliable stamp", which is NOT the same as "no keys" — OpenAI's bare `sk-` is
   * deliberately absent because every OpenAI-compatible provider copies it on purpose.
   */
  keyPrefixes: string[];
  /**
   * Does the provider's own /models response carry per-model prices?
   *
   * Only Groq and OpenRouter do, of everything measured. For the rest, a model's cost is unknown
   * until an operator sets it — which is what the unpriced warning exists to say out loud.
   */
  publishesPricing: boolean;
  /**
   * A token inside baseUrl/modelFetchUrl the operator must replace before the pool can work.
   *
   * Cloudflare routes per account, so its URLs are not knowable in advance. Modelled as data so
   * the dialog can ask for the value and substitute it, instead of handing over a URL containing
   * a literal placeholder that fails at the first request with a 404 nobody can read.
   */
  accountPlaceholder?: { token: string; label: string; hint: string };
  /** What was measured on 2026-08-10 — see the header. */
  verified: 'chat' | 'models' | null;
  /** Anything an operator needs to know that the fields above cannot express. */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    slug: 'openai', label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    // No note: `publishesPricing: false` already makes the dashboard say so, and a note repeating
    // it renders two lines of the same sentence. Notes are for what the fields cannot express.
    keyPrefixes: [], publishesPricing: false, verified: null,
  },
  {
    slug: 'anthropic', label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    // The raw key, no scheme — and /models is refused without a version header.
    authHeader: 'x-api-key', authPrefix: '',
    modelIdPath: 'data[].id', extraHeaders: { 'anthropic-version': '2023-06-01' },
    keyPrefixes: ['sk-ant-'], publishesPricing: false, verified: null,
  },
  {
    slug: 'google', label: 'Google',
    // Google's own protocol is not OpenAI-shaped; this is its OpenAI-compatibility endpoint, and
    // the `/openai` suffix is load-bearing.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: ['AIza'], publishesPricing: false, verified: 'chat',
    note: 'Its model list advertises models this account may not be able to use: on a new key most '
        + 'answer 404 "no longer available to new users", and the free tier rate-limits per model '
        + '(gemini-2.0-flash returned 429 while gemini-flash-lite-latest served normally with the '
        + 'same key). Fetching models here lists more than will actually route — test before relying '
        + 'on one.',
  },
  {
    slug: 'groq', label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: ['gsk_'], publishesPricing: true, verified: 'chat',
  },
  {
    slug: 'openrouter', label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: ['sk-or-'], publishesPricing: true, verified: 'chat',
    note: 'Prices are per-model and OpenRouter\'s own — a model it resells is not necessarily the '
        + 'upstream vendor\'s price. Its `:free` models publish a genuine zero.',
  },
  {
    slug: 'mistral', label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: [], publishesPricing: false, verified: 'chat',
  },
  {
    slug: 'huggingface', label: 'HuggingFace',
    baseUrl: 'https://router.huggingface.co/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: ['hf_'], publishesPricing: false, verified: 'chat',
    note: 'A router, not a provider: it dispatches to a third-party host (Fireworks, Together, …) '
        + 'and the response may name a different model id than the request did — so a price is not '
        + 'derivable from the model id even in principle.',
  },
  {
    slug: 'cloudflare', label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    // The OpenAI-compatible base answers /models with 405. The catalogue is elsewhere, and shaped
    // differently — this is the pair of fields the whole modelFetchUrl/modelIdPath split is for.
    modelFetchUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search',
    modelIdPath: 'result[].name', extraHeaders: {},
    keyPrefixes: [], publishesPricing: false, verified: 'chat',
    accountPlaceholder: {
      token: '{account_id}',
      label: 'Cloudflare account ID',
      hint: 'from the Workers AI dashboard URL — substituted into both URLs below',
    },
    note: 'Bills in "neurons", not tokens. Any per-token price set here is an approximation of a '
        + 'different unit and will not reconcile exactly with a Cloudflare invoice.',
  },
  {
    slug: 'cerebras', label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: [], publishesPricing: false, verified: 'models',
    note: 'Model list works on a free key; every completion answered 402 (payment required) until '
        + 'the account is funded. Listed as models-only rather than chat-verified for that reason.',
  },
  {
    slug: 'custom', label: 'Custom',
    // Deliberately blank. A custom pool is a URL we cannot guess, and a plausible default here
    // would be a wrong one that saves cleanly.
    baseUrl: '', authHeader: 'Authorization', authPrefix: 'Bearer',
    modelIdPath: 'data[].id', extraHeaders: {},
    keyPrefixes: [], publishesPricing: false, verified: null,
  },
];

const BY_SLUG = new Map(PROVIDER_PRESETS.map((p) => [p.slug, p]));

/** The preset for a slug, or undefined when the operator is running something we do not ship. */
export function presetFor(slug: string): ProviderPreset | undefined {
  return BY_SLUG.get(slug);
}

/**
 * The base URL for a provider with none stored on its pool.
 *
 * Empty string for anything unknown, which is the pre-existing contract: an empty base is what
 * makes the pool unroutable rather than routed somewhere arbitrary.
 */
export function providerDefaultUrl(slug: string): string {
  return BY_SLUG.get(slug)?.baseUrl ?? '';
}

/** How to name a provider in something a human reads. Unknown slugs are shown as themselves. */
export function providerLabel(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug;
}

/** True when this provider's own model list carries prices we can harvest. */
export function publishesPricing(slug: string): boolean {
  return BY_SLUG.get(slug)?.publishesPricing ?? false;
}
