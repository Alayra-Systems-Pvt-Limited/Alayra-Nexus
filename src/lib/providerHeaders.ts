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

// A provider's optional extra request headers (Phase 7.4d). Stored on NexusProvider.extraHeaders as
// a JSON object string; parsed here into a plain header map. This is the single place that reads that
// column, so every outbound call site (model-fetch, validation probes, the proxy path) applies the
// same rules — no drift.

// Defensive caps so a malformed or hostile value can neither flood a request nor smuggle a huge
// payload. A provider legitimately needs a handful of small headers (e.g. anthropic-version).
const MAX_HEADERS      = 20;
const MAX_VALUE_LENGTH = 1024;

/**
 * Parse a provider's `extraHeaders` JSON into a header map. Only string→string entries survive;
 * anything else (nested objects, numbers, oversized values, a non-object root, invalid JSON) is
 * dropped rather than throwing, so a bad value degrades to "no extra headers" instead of breaking
 * the request. Returns an empty object when there is nothing usable.
 */
export function parseExtraHeaders(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_HEADERS) break;
    const name = key.trim();
    if (!name || typeof value !== 'string') continue;
    if (value.length > MAX_VALUE_LENGTH) continue;
    out[name] = value;
    count++;
  }
  return out;
}

/**
 * Merge a provider's extra headers under a set of system headers, so the system headers (auth,
 * content-type) always win: an operator can add a required header but can never override the
 * credential the gateway attaches. Extra headers go on first; system headers are spread last.
 */
export function withExtraHeaders(
  extraHeaders: string | null | undefined,
  systemHeaders: Record<string, string>,
): Record<string, string> {
  return { ...parseExtraHeaders(extraHeaders), ...systemHeaders };
}

// The provider auth header, built in ONE place for the same reason extraHeaders are parsed in
// one place. Six call sites used to inline `${authPrefix ?? 'Bearer'} ${key}`, and the operator
// types that prefix: `Bearer ` with a trailing space — the natural way to type a prefix — became
// `Bearer  <key>` (double space), and a deliberately empty prefix (providers that take the bare
// key) became ` <key>`. Either way the provider refuses the credential and the pool fails auth
// with nothing to debug, because an auth header is never displayed anywhere. Found by the e2e
// suite's upstream ledger, which is the only place the assembled header is ever visible.

/** `Bearer <key>` with exactly one space; a blank prefix means the key stands alone. */
export function authHeaderValue(prefix: string | null | undefined, key: string): string {
  const p = (prefix ?? 'Bearer').trim();
  return p ? `${p} ${key}` : key;
}

/** The complete auth header entry: trimmed name (a padded name is an invalid HTTP token), safe value. */
export function providerAuthHeader(
  name: string | null | undefined,
  prefix: string | null | undefined,
  key: string,
): Record<string, string> {
  const header = (name ?? '').trim() || 'Authorization';
  return { [header]: authHeaderValue(prefix, key) };
}
