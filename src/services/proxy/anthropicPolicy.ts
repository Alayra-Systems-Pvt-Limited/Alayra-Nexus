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

// ── What a native Anthropic request may carry ─────────────────────────────────────────────────
//
// On the native path the caller writes the body Anthropic receives, and Anthropic bills some request
// fields beyond tokens: a faster mode at a higher rate, a priority tier, a regional premium, server
// tools charged per use or by container time, a fallback to a model routing never chose. Nexus
// records and limits spend from token counts and the per-use prices in the model registry, so a field
// it cannot price is spend it could neither record nor cap. Such a field is removed before the request
// leaves, and the answer names it in `X-Nexus-Stripped`. The request itself still runs.
//
// An operator who accepts that a pool may run up such charges unrecorded lists the field in the pool's
// settings (NexusProvider.nativeMessages, e.g. {"allow":["speed","code_execution"]}). Those charges are
// then neither recorded nor limited by Nexus.
//
// Request fields: https://platform.claude.com/docs/en/api/messages/create
// Server and client tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference

/** A pool's settings for Anthropic Messages requests. */
export interface NativePolicy {
  /** true: native whatever the auth header; false: never native; undefined: decided by the auth header. */
  enabled?: boolean;
  /** Request fields, server-tool families and beta features let through although Nexus cannot price them. */
  allow:    ReadonlySet<string>;
}

const DEFAULTS: NativePolicy = { allow: new Set() };

/** Read the pool's stored settings. Never throws: anything malformed reads as the defaults. */
export function readNativePolicy(raw: string | null | undefined): NativePolicy {
  if (!raw) return DEFAULTS;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return DEFAULTS; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULTS;
  const p = parsed as { enabled?: unknown; allow?: unknown };
  const allow = Array.isArray(p.allow) ? p.allow.filter((a): a is string => typeof a === 'string').map((a) => a.trim()) : [];
  return { ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}), allow: new Set(allow) };
}

/**
 * Documented request fields that Anthropic bills as tokens only, at the model's prices. Always
 * forwarded. Every other top-level field (`speed`, `service_tier`, `inference_geo`, `container`,
 * `mcp_servers`, `fallbacks`, `context_management`, anything newer) is forwarded only when allowed.
 */
export const PRICED_FIELDS: ReadonlySet<string> = new Set([
  'model', 'messages', 'max_tokens', 'system', 'stream', 'stop_sequences', 'temperature', 'top_p', 'top_k',
  'thinking', 'tools', 'tool_choice', 'metadata', 'cache_control', 'output_config', 'diagnostics',
]);

/**
 * Anthropic tools that run on the caller's side: the model only asks for them, so they cost tokens
 * and nothing else. A tool with no type, or `custom`, is the caller's own and is the same.
 */
const CLIENT_TOOL_PREFIXES = ['memory_', 'bash_', 'text_editor_', 'computer_', 'browser_toolset_'];

/** A tool type without its version date: `web_search_20260209` → `web_search`. */
export const toolFamily = (type: string): string => type.replace(/_\d{8}$/, '');

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** True for a tool Anthropic runs itself, which may bill beyond tokens. An unknown type counts as one. */
export function isServerTool(tool: unknown): boolean {
  if (!isObject(tool) || typeof tool.type !== 'string' || tool.type === 'custom') return false;
  const type = tool.type;
  return !CLIENT_TOOL_PREFIXES.some((p) => type.startsWith(p));
}

/** Does the body declare any server tool? Only then is the model registry consulted. */
export const hasServerTools = (body: Json): boolean => Array.isArray(body.tools) && body.tools.some(isServerTool);

export interface ShapeInput {
  body:   Json;
  policy: NativePolicy;
  /** Is this server-tool family priced on the routed model, so its use is recorded and budgeted? */
  priced: (family: string) => boolean;
  /**
   * The route uses a shared key, not the team's own. A container (and the skills in it) belongs to
   * the key's organisation, so it is never reachable through a shared key, allowed or not.
   */
  shared: boolean;
}

export interface Shaped {
  body:     Json;
  /** What was removed, for `X-Nexus-Stripped`: field names, and `tool:<type>` for a tool. */
  stripped: string[];
}

/** The body Anthropic may receive: the caller's, minus every field and tool Nexus cannot price. */
export function shapeNativeBody({ body, policy, priced, shared }: ShapeInput): Shaped {
  const out: Json = {};
  const stripped: string[] = [];
  for (const [field, value] of Object.entries(body)) {
    const allowed = PRICED_FIELDS.has(field) || (policy.allow.has(field) && !(shared && field === 'container'));
    if (allowed) out[field] = value; else stripped.push(field);
  }
  if (Array.isArray(out.tools)) shapeTools(out, out.tools, policy, priced, stripped);
  return { body: out, stripped };
}

/** Keep custom, client and priced server tools; drop the rest and any tool_choice that names one. */
function shapeTools(out: Json, tools: unknown[], policy: NativePolicy, priced: (family: string) => boolean, stripped: string[]): void {
  const removed = new Set<string>();
  const kept = tools.filter((t) => {
    if (!isServerTool(t)) return true;
    const type = String((t as Json).type);
    const family = toolFamily(type);
    if (policy.allow.has(family) || priced(family)) return true;
    stripped.push(`tool:${type}`);
    if (typeof (t as Json).name === 'string') removed.add((t as Json).name as string);
    return false;
  });
  if (kept.length === tools.length) return;
  const choice = out.tool_choice;
  const namesRemoved = isObject(choice) && choice.type === 'tool' && removed.has(String(choice.name));
  if (kept.length) out.tools = kept; else delete out.tools;
  // A choice that names a removed tool, or any choice once no tool is left, would be refused.
  if (choice !== undefined && (namesRemoved || !kept.length)) { delete out.tool_choice; stripped.push('tool_choice'); }
}

// ── Beta features ─────────────────────────────────────────────────────────────────────────────

/** Betas that only switch on a feature named in `allow`; without it they go. */
const BETA_FEATURES: ReadonlyArray<readonly [prefix: string, feature: string]> = [
  ['fast-mode-', 'speed'],
  ['advisor-tool-', 'advisor'],
  ['mcp-client-', 'mcp_servers'],
  ['code-execution-', 'code_execution'],
  ['skills-', 'container'],
  ['context-management-', 'context_management'],
  // A longer context window, billed at a higher rate past a threshold on some models.
  ['context-1m-', 'context-1m'],
];

/** A beta that changes how the request authenticates: never sent beside a pool's API key. */
const changesAuth = (beta: string): boolean => beta.startsWith('oauth-');

const splitList = (v: string | undefined): string[] => (v ?? '').split(',').map((b) => b.trim()).filter(Boolean);

export interface Betas {
  /** The `anthropic-beta` value to send, or undefined for none. */
  value:    string | undefined;
  /** What was removed, as `anthropic-beta:<name>`. */
  stripped: string[];
}

/**
 * The operator's betas and the caller's, together (the caller adding one must not drop the pool's).
 * An auth-changing beta never goes. A caller's beta that only switches on a feature the pool does not
 * allow goes too; the operator's own betas count as allowed, since the operator chose them.
 */
export function nativeBetas(operator: string | undefined, caller: string | undefined, policy: NativePolicy): Betas {
  const stripped: string[] = [];
  const keep = new Set<string>();
  for (const b of splitList(operator)) {
    if (changesAuth(b)) stripped.push(`anthropic-beta:${b}`); else keep.add(b);
  }
  for (const b of splitList(caller)) {
    if (keep.has(b)) continue;
    const feature = BETA_FEATURES.find(([prefix]) => b.startsWith(prefix))?.[1];
    if (changesAuth(b) || (feature !== undefined && !policy.allow.has(feature))) stripped.push(`anthropic-beta:${b}`);
    else keep.add(b);
  }
  return { value: keep.size ? [...keep].join(',') : undefined, stripped };
}

// ── Telling the caller ────────────────────────────────────────────────────────────────────────

const MAX_NAMED = 32;

/**
 * The `X-Nexus-Stripped` value: what was removed, comma-separated. The names come from the caller's
 * own body, so anything outside a plain token alphabet is replaced (a header value may not carry
 * line breaks or arbitrary bytes), and the list is capped.
 */
export function strippedHeader(stripped: readonly string[]): string | undefined {
  if (!stripped.length) return undefined;
  const named = stripped.slice(0, MAX_NAMED).map((s) => s.replace(/[^\w.:-]/g, '_').slice(0, 96));
  if (stripped.length > MAX_NAMED) named.push(`and ${stripped.length - MAX_NAMED} more`);
  return named.join(', ');
}
