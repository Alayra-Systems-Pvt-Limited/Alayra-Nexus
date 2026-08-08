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

// Is this credential even from the provider this pool talks to?
//
// ── The mistake this catches ──────────────────────────────────────────────────────────────────
//
// A pool is bound to one provider: its slug picks the base URL, the auth header and the models.
// Every key inside it inherits that. So an OpenRouter key pasted into an Anthropic pool is not a
// configuration choice, it is a typo — and the way it fails is bad. The key saves fine, then every
// request routed to it comes back 401, the breaker counts auth failures, and after two of them the
// key is banned. The operator sees a pool that silently stopped working, several minutes after the
// action that broke it, with nothing connecting the two.
//
// ── Why a prefix is worth checking at all ─────────────────────────────────────────────────────
//
// Most issuers stamp their keys. `sk-ant-` is Anthropic, `sk-or-v1-` is OpenRouter, `hf_` is
// HuggingFace, `gsk_` is Groq, `AIza` is Google. That is enough to reject the common paste error
// instantly, offline, before anything is written.
//
// It is a convention rather than a contract, which decides the shape of the rule:
//
//   * a bare `sk-` says almost nothing. OpenAI uses it and every OpenAI-compatible provider copies
//     it deliberately, so it can only ever be evidence of NOT being one of the distinctly-stamped
//     ones.
//   * Mistral and self-hosted providers have no reliable stamp at all, so `custom` and anything
//     unlisted must pass without comment.
//   * formats change — OpenAI added `sk-proj-` years after `sk-`. A rule that hard-fails on anything
//     it does not recognise would start rejecting valid keys the week a provider rotates its format,
//     and the operator would have no idea why.
//
// So this only ever rejects a POSITIVE mismatch: the key carries another provider's unmistakable
// stamp. Unrecognised is not wrong, and is allowed through — the live credential check is what
// catches those.

/** Prefixes that identify an issuer beyond reasonable doubt. Bare `sk-` is deliberately absent. */
const DISTINCTIVE: Record<string, string[]> = {
  anthropic:  ['sk-ant-'],
  openrouter: ['sk-or-'],
  google:     ['AIza'],
  groq:       ['gsk_'],
  huggingface: ['hf_'],
};

/** How to name a provider in an error an operator has to act on. */
const LABEL: Record<string, string> = {
  anthropic:   'Anthropic',
  openrouter:  'OpenRouter',
  google:      'Google',
  groq:        'Groq',
  huggingface: 'HuggingFace',
  openai:      'OpenAI',
};

export function providerLabel(slug: string): string {
  return LABEL[slug] ?? slug;
}

/**
 * The provider whose stamp this key carries, or null when it carries none we recognise.
 *
 * Longest match wins so a more specific prefix cannot be shadowed by a shorter one.
 */
export function issuerOf(apiKey: string): string | null {
  const key = apiKey.trim();
  let best: { slug: string; length: number } | null = null;

  for (const [slug, prefixes] of Object.entries(DISTINCTIVE)) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix) && (best === null || prefix.length > best.length)) {
        best = { slug, length: prefix.length };
      }
    }
  }
  return best?.slug ?? null;
}

/**
 * An error message when this key unmistakably belongs to a different provider, else null.
 *
 * Null covers three different situations on purpose, because none of them is evidence of a mistake:
 * the key matches, the key carries no recognisable stamp, or the pool is a `custom` one whose keys
 * can look like anything.
 */
export function keyProviderMismatch(providerSlug: string, apiKey: string): string | null {
  if (!apiKey?.trim()) return null;
  // A custom pool points at an arbitrary base URL — a local llama.cpp, a corporate proxy, another
  // Nexus. Its keys have no format we could be right about.
  if (providerSlug === 'custom') return null;

  const issuer = issuerOf(apiKey);
  if (issuer === null || issuer === providerSlug) return null;

  return `This looks like ${providerLabel(issuer)} key, but this pool is ${providerLabel(providerSlug)}. `
    + `A pool serves one provider — add a ${providerLabel(issuer)} pool for this key, or paste a `
    + `${providerLabel(providerSlug)} key here.`;
}
