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

// ── The native Anthropic passthrough ──────────────────────────────────────────────────────────
//
// A `/v1/messages` request is translated to the OpenAI shape so that admission, guardrails, the
// response cache, sticky routing and the token reserve all work on it exactly as on
// `/v1/chat/completions`. When routing then lands on Anthropic itself, translating it on to
// Anthropic's OpenAI-compatible endpoint loses what that endpoint does not carry: prompt caching
// (`cache_control`), extended thinking, `document` blocks, server tools, `top_k`. So that one case
// goes to Anthropic's own `/messages` with the caller's own body, and the answer comes back
// untouched. Every other provider keeps the translation.
//
// It goes native only when that is safe to do: the pool is set up for Anthropic's own API, routing
// chose the very model the caller asked for, the guardrails neither changed the request nor need to
// read the answer, and nothing in the body escapes what Nexus can price (anthropicPolicy.ts) or what
// the guardrails can see (anthropicGuard.ts). Otherwise the translated path serves it, as before.
//
// Everything else about the call is shared with the translated path: the same key choice, abort
// controller, time limits, hang-up watch, breaker, sticky pin and usage row. Deciding takes no I/O,
// except a read of the in-process model registry when the body declares a server tool.

import { stripTrailingSlash } from '../../lib/url';
import { parseExtraHeaders, providerAuthHeader } from '../../lib/providerHeaders';
import { serverToolPriced } from '../../lib/usagePrice';
import { getModelRegistry } from '../model.service';
import type { NexusRoute } from '../nexus.service';
import type { GuardedRequest } from './inputGuard';
import { referencesOrgFiles, sentWholeToday } from './anthropicGuard';
import { hasServerTools, nativeBetas, readNativePolicy, shapeNativeBody, type NativePolicy } from './anthropicPolicy';
import type { AnthropicNative } from './types';

/** The provider whose own API the caller is speaking. */
export const NATIVE_PROVIDER = 'anthropic';

/**
 * The caller's headers that go on to Anthropic: the API version their body is written for, and the
 * beta features it uses (a 1-hour cache, for one). Nothing else is forwarded, and above all not the
 * caller's own credential, which is a Nexus key.
 */
export const NATIVE_HEADERS = ['anthropic-version', 'anthropic-beta'] as const;

/** Pick the allow-listed headers out of the caller's request (Node lower-cases header names). */
export function pickNativeHeaders(reqHeaders: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of NATIVE_HEADERS) {
    const v = reqHeaders[name];
    const value = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(',') : v;
    if (typeof value === 'string' && value.trim()) out[name] = value.trim();
  }
  return out;
}

/** The version Anthropic's API is called with when neither the caller nor the pool names one. */
export const DEFAULT_VERSION = '2023-06-01';

/**
 * Is the pool set up for Anthropic's own API? A pool's explicit setting decides; otherwise only a pool
 * that authenticates with `x-api-key`, as Anthropic's API does. A pool on `Authorization: Bearer`
 * may point at an OpenAI-compatible relay that has no `/messages`, so it keeps the translated path.
 */
export function poolSpeaksNative(route: NexusRoute, policy: NativePolicy): boolean {
  return policy.enabled ?? route.authHeader.trim().toLowerCase() === 'x-api-key';
}

/**
 * Did routing choose the model the caller asked for? The caller's body is written for that model
 * (its thinking mode, effort, sampling settings); another model, a downgrade above all, may refuse
 * them, where the translated path simply leaves them out.
 */
export function servesRequestedModel(requested: unknown, route: NexusRoute): boolean {
  return !route.wasDowngrade && typeof requested === 'string' && requested.trim().toLowerCase() === route.modelString.toLowerCase();
}

/** Which server-tool families the routed model prices. Unknown or unreadable means none. */
async function serverToolPricing(route: NexusRoute): Promise<(family: string) => boolean> {
  let model: Record<string, unknown> | undefined;
  try {
    const registry = await getModelRegistry();
    model = registry.find((r) => r.modelString === route.modelString || (route.modelId !== null && r.id === route.modelId)) as
      unknown as Record<string, unknown> | undefined;
  } catch { /* unpriced: the tool is removed rather than run unrecorded */ }
  return (family) => serverToolPriced(model, family);
}

export interface NativeRequest {
  url:      string;
  body:     Record<string, unknown>;
  headers:  Record<string, string>;
  /** What was removed from the caller's request, for `X-Nexus-Stripped`. */
  stripped: string[];
}

/**
 * The request to send to Anthropic's own API, or null to keep the translated path. See the top of
 * this file for when; anthropicPolicy.ts and anthropicGuard.ts for what the body may carry.
 */
export async function planNative(
  native: AnthropicNative | undefined, route: NexusRoute, guarded: GuardedRequest, messages: unknown[],
): Promise<NativeRequest | null> {
  if (!native || route.providerSlug !== NATIVE_PROVIDER) return null;
  const policy = readNativePolicy(route.nativeMessages);
  if (!poolSpeaksNative(route, policy) || !servesRequestedModel(native.body.model, route)) return null;
  // A redacted prompt must go as redacted, and output rules work on the translated form.
  if (guarded.effectiveMessages !== messages || guarded.outputFiltering) return null;

  const priced = hasServerTools(native.body) ? await serverToolPricing(route) : () => false;
  const shaped = shapeNativeBody({ body: native.body, policy, priced, shared: !route.byok });
  if (!route.byok && referencesOrgFiles(shaped.body)) return null;
  const guardrailsOn = guarded.guard.enabled && guarded.guard.compiled.length > 0;
  if (guardrailsOn && !sentWholeToday(shaped.body)) return null;

  const { headers, stripped } = nativeHeaders(native.headers, route, policy);
  return {
    url:      `${stripTrailingSlash(route.baseUrl)}/messages`,
    body:     { ...shaped.body, model: route.modelString },
    headers,
    stripped: [...shaped.stripped, ...stripped],
  };
}

/**
 * The headers for Anthropic: the pool's configured ones, the API version (the caller's, else the
 * pool's, else the default), the pool's and the caller's beta features together, and the route's
 * credential. The credential and content type always win.
 */
export function nativeHeaders(
  caller: Record<string, string>, route: NexusRoute, policy: NativePolicy,
): { headers: Record<string, string>; stripped: string[] } {
  const configured = Object.entries(parseExtraHeaders(route.extraHeaders));
  const own = (name: string) => configured.find(([k]) => k.toLowerCase() === name)?.[1];
  const reserved = new Set<string>([...NATIVE_HEADERS, 'content-type', route.authHeader.trim().toLowerCase()]);
  const betas = nativeBetas(own('anthropic-beta'), caller['anthropic-beta'], policy);
  return {
    headers: {
      ...Object.fromEntries(configured.filter(([k]) => !reserved.has(k.toLowerCase()))),
      'anthropic-version': caller['anthropic-version'] ?? own('anthropic-version') ?? DEFAULT_VERSION,
      ...(betas.value ? { 'anthropic-beta': betas.value } : {}),
      'Content-Type': 'application/json',
      ...providerAuthHeader(route.authHeader, route.authPrefix, route.decryptedKey),
    },
    stripped: betas.stripped,
  };
}
