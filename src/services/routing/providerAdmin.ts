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

import { coreStores } from '../../core/stores';
// The open-source AES cipher directly, not the core's installable one (P1.1). Everything here is an
// operator button in this gateway's own dashboard and is not part of the core's public surface, and
// the check rows the ports return (KeyCheck, ProviderCheck) carry no key id or owner to hand a host
// cipher. A host that installs its own cipher tests keys in its own vault instead.
import { decrypt } from '../../lib/encryption';
import { stripTrailingSlash, assertSafeUrl } from '../../lib/url';
import { safeFetch } from '../../lib/safeFetch';
import { extractModelMeta, type FetchedModel } from '../../lib/modelPath';
import { withExtraHeaders, providerAuthHeader } from '../../lib/providerHeaders';
import { providerDefaultUrl } from '../../data/providers';
import { getSsrfPolicy } from '../ssrf.service';

// ── Operator checks: test a key, a credential, a model, or fetch a model list ──
// Off the request path: these run when an operator presses a button in the dashboard. Every
// outbound call is SSRF-guarded and fetches the URL object the guard returned.

/** Call a key's pool `/models` with it, to show the operator whether it still works. */
export async function testKey(keyId: string): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  const key = await (await coreStores()).keys.findForCheck(keyId);
  if (!key) return { success: false, error: 'Key not found' };

  const apiKey  = decrypt(key.encryptedKey);
  const baseUrl = stripTrailingSlash(key.provider.baseUrl ?? providerDefaultUrl(key.provider.provider));
  const start   = Date.now();

  try {
    // Fetch the validated URL object the SSRF guard returns — not a re-concatenated string — so the
    // target reaching fetch() is exactly the one vetted (private/metadata/loopback already rejected).
    const safeUrl = assertSafeUrl(baseUrl, await getSsrfPolicy());
    safeUrl.pathname = `${stripTrailingSlash(safeUrl.pathname)}/models`;
    const res = await safeFetch(safeUrl, {
      headers: withExtraHeaders(key.provider.extraHeaders, providerAuthHeader(key.provider.authHeader, key.provider.authPrefix, apiKey)),
      signal:  AbortSignal.timeout(5000),
    });
    return { success: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function validateProviderCredentials(
  provider: string,
  baseUrl: string | null,
  apiKey: string,
  authHeader: string,
  authPrefix: string | null,
  extraHeaders: string | null = null,
): Promise<{ ok: boolean; latencyMs: number; error?: string; status?: number }> {
  const base  = stripTrailingSlash(baseUrl ?? providerDefaultUrl(provider));
  const start = Date.now();
  try {
    // Validate against SSRF policy and fetch the *returned* URL object — not a separately
    // concatenated string — so the value that reaches fetch() is the one the guard vetted (private
    // hosts / metadata / loopback already rejected). Single source of truth, no unchecked side path.
    const safeUrl = assertSafeUrl(base, await getSsrfPolicy());
    safeUrl.pathname = `${stripTrailingSlash(safeUrl.pathname)}/models`;
    const res = await safeFetch(safeUrl, {
      headers: withExtraHeaders(extraHeaders, providerAuthHeader(authHeader, authPrefix, apiKey)),
      signal:  AbortSignal.timeout(8000),
    });
    // `status` is returned alongside `ok` because callers need to tell WHY a check failed, not only
    // that it did. A 401 or 403 means the credential is wrong and is worth refusing a save over; a
    // 404 usually means the provider has no `/models` route, which says nothing about the key.
    return {
      ok: res.ok, status: res.status, latencyMs: Date.now() - start,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export async function validateModel(
  providerId: string,
  modelName: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const provider = await (await coreStores()).providers.findForCheck(providerId);
  if (!provider)              return { ok: false, latencyMs: 0, error: 'Provider not found' };
  if (!provider.activeKey)    return { ok: false, latencyMs: 0, error: 'No active key for this provider — add a key first' };

  const apiKey  = decrypt(provider.activeKey);
  const baseUrl = stripTrailingSlash(provider.baseUrl ?? providerDefaultUrl(provider.provider));
  const start   = Date.now();

  try {
    // Fetch the validated URL object (see testKey / validateProviderCredentials) so the request
    // target is the one the SSRF guard vetted, not a separately built string.
    const safeUrl = assertSafeUrl(baseUrl, await getSsrfPolicy());
    safeUrl.pathname = `${stripTrailingSlash(safeUrl.pathname)}/chat/completions`;
    const res = await safeFetch(safeUrl, {
      method:  'POST',
      headers: withExtraHeaders(provider.extraHeaders, {
        'Content-Type': 'application/json',
        ...providerAuthHeader(provider.authHeader, provider.authPrefix, apiKey),
      }),
      body:   JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    if (res.ok) return { ok: true, latencyMs };
    const errText = await res.text().catch(() => '');
    return { ok: false, latencyMs, error: `HTTP ${res.status}: ${errText.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Request failed' };
  }
}

// The upper bound on models returned from a fetch — a defensive cap so a misconfigured path
// pointed at a huge array can't flood the dashboard.
const MAX_FETCHED_MODELS = 500;

// Long enough for a full provider catalogue over a slow hop (a 344-model OpenRouter payload is
// several hundred KB), short enough that a dead endpoint still fails while the operator is watching.
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch a provider's live model list (Phase 7.4b). Calls the pool's `modelFetchUrl` (or the
 * conventional `<baseUrl>/models`) with a key, and reads the ids using the pool's `modelIdPath`.
 * This is how "Fetch Models" stays future-proof: a provider releasing a new model surfaces it here
 * with no code change. `plainKey` lets the add-key form fetch before its key is saved; otherwise an
 * existing active key for the pool is used. SSRF-guarded like every other outbound admin call.
 */
export async function fetchProviderModels(
  providerId: string,
  plainKey?: string,
): Promise<{ ok: boolean; models: FetchedModel[]; error?: string }> {
  const provider = await (await coreStores()).providers.findForCheck(providerId);
  if (!provider) return { ok: false, models: [], error: 'Provider not found' };

  let apiKey = plainKey?.trim();
  if (!apiKey) {
    if (!provider.activeKey) return { ok: false, models: [], error: 'Enter an API key, or add an active key to this pool first' };
    apiKey = decrypt(provider.activeKey);
  }

  const base = stripTrailingSlash(provider.baseUrl ?? providerDefaultUrl(provider.provider));
  const url  = provider.modelFetchUrl ?? (base ? `${base}/models` : '');
  if (!url) return { ok: false, models: [], error: 'No base URL or model-fetch URL configured for this pool' };

  try {
    // Fetch the *returned* URL object, matching the other guarded sites in this file — the value
    // that reaches safeFetch is the one the guard vetted, not a separately-held string.
    const safeUrl = assertSafeUrl(url, await getSsrfPolicy());
    const res = await safeFetch(safeUrl, {
      headers: withExtraHeaders(provider.extraHeaders, providerAuthHeader(provider.authHeader, provider.authPrefix, apiKey)),
      // A full catalogue is big — OpenRouter alone answers with ~344 models — and a slow hop to the
      // provider could exceed the old 8s and read as "no models" rather than "too slow".
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Name the URL that was actually called in every failure. A pool pointed at the wrong endpoint
    // (or a stale modelIdPath) otherwise reports an unexplained empty list, and the operator has no
    // way to see which of their three URL fields produced it.
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status} from ${url}` };
    const json   = await res.json().catch(() => null);
    const models = extractModelMeta(json, provider.modelIdPath).slice(0, MAX_FETCHED_MODELS);
    if (!models.length) {
      return { ok: false, models: [], error: `No models found at "${provider.modelIdPath ?? 'data[].id'}" in the response from ${url}` };
    }
    return { ok: true, models };
  } catch (err) {
    const why = err instanceof Error ? err.message : 'Fetch failed';
    return { ok: false, models: [], error: `${why} (${url})` };
  }
}
