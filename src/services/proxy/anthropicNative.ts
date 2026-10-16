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
// goes to Anthropic's own `/messages` with the caller's body as sent, and the answer comes back
// untouched. Every other provider keeps the translation.
//
// Everything else about the call is shared with the translated path: the same key choice, abort
// controller, time limits, hang-up watch, breaker, sticky pin and usage row. Deciding takes no I/O.

import { stripTrailingSlash } from '../../lib/url';
import { parseExtraHeaders, providerAuthHeader } from '../../lib/providerHeaders';
import type { NexusRoute } from '../nexus.service';
import type { GuardedRequest } from './inputGuard';
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

// ── Guardrails ────────────────────────────────────────────────────────────────────────────────
//
// The input guardrails scan the translated messages, the same as on the translated path. So with
// guardrails on, the native path may send only what that path also sends: text and the text of tool
// results, which the scan reads, and tool calls and images, which the translated path forwards
// unscanned today. Anything the translated path would drop (documents, thinking, server-tool blocks,
// a tool result holding an image, a type nobody knows yet) keeps the request on the translated path.

const SENT_TODAY = new Set(['text', 'tool_use', 'image']);

type Block = Record<string, unknown>;

const isBlock = (b: unknown): b is Block => !!b && typeof b === 'object' && !Array.isArray(b);

/** A tool result whose content the scan reads whole: a string, or text blocks only. */
const textOnlyResult = (b: Block): boolean =>
  b.content === undefined || typeof b.content === 'string'
  || (Array.isArray(b.content) && b.content.every((p) => isBlock(p) && p.type === 'text'));

const blockSentToday = (b: unknown): boolean =>
  isBlock(b) && (SENT_TODAY.has(String(b.type)) || (b.type === 'tool_result' && textOnlyResult(b)));

/** Content (a string, or an array of blocks) that the translated path would send whole. */
const contentSentToday = (content: unknown): boolean =>
  content === undefined || typeof content === 'string' || (Array.isArray(content) && content.every(blockSentToday));

/** True when every part of the body is either scanned or already forwarded unscanned today. */
export function sentWholeToday(body: Record<string, unknown>): boolean {
  const system = body.system;
  if (system !== undefined && typeof system !== 'string'
    && !(Array.isArray(system) && system.every((b) => isBlock(b) && b.type === 'text'))) return false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.every((m) => isBlock(m) && contentSentToday(m.content));
}

/**
 * Should this request go to Anthropic as sent? Only when it was routed to Anthropic, and the
 * guardrails did not change it (a redacted prompt must go as redacted) or need to read the answer
 * (output rules work on the translated form), and, with guardrails on, nothing in it escapes the scan
 * that the translated path would have kept back.
 */
export function goesNative(
  native: AnthropicNative | undefined, route: NexusRoute, guarded: GuardedRequest, messages: unknown[],
): native is AnthropicNative {
  if (!native || route.providerSlug !== NATIVE_PROVIDER) return false;
  if (guarded.effectiveMessages !== messages || guarded.outputFiltering) return false;
  const guardrailsOn = guarded.guard.enabled && guarded.guard.compiled.length > 0;
  return !guardrailsOn || sentWholeToday(native.body);
}

export interface NativeRequest {
  url:     string;
  body:    Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Anthropic's own endpoint beside the OpenAI-compatible one (`<base>/messages`, as `<base>/chat/
 * completions` is), the caller's body with only the model set to the one routing chose, and the
 * route's credential. The caller's version and beta headers replace the provider's configured ones
 * of the same name; the credential and content type always win.
 */
export function nativeRequest(native: AnthropicNative, route: NexusRoute): NativeRequest {
  const body = native.body.model === route.modelString ? native.body : { ...native.body, model: route.modelString };
  const own = new Set(Object.keys(native.headers));
  const configured = Object.fromEntries(
    Object.entries(parseExtraHeaders(route.extraHeaders)).filter(([name]) => !own.has(name.toLowerCase())),
  );
  return {
    url: `${stripTrailingSlash(route.baseUrl)}/messages`,
    body,
    headers: {
      ...configured,
      ...native.headers,
      'Content-Type': 'application/json',
      ...providerAuthHeader(route.authHeader, route.authPrefix, route.decryptedKey),
    },
  };
}
