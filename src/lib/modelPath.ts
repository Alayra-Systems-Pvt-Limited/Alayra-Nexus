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

// Extract a provider's model ids from its /models JSON, guided by the pool's `modelIdPath`.
// A provider is free to shape its response however it likes — OpenAI/Anthropic use
// `{ data: [{ id }] }` (path `data[].id`), some gateways return a bare array (`[].id`), others
// nest it (`result.models[].name`). Rather than hard-code one shape, the operator declares the
// path once on the pool and this reads it. Deliberately tiny — a full JSONPath engine would be a
// dependency and an attack surface for a one-line need.

const DEFAULT_PATH = 'data[].id';

/** Walk a dotted path (`a.b.c`) into a plain object; undefined on any missing hop. */
function walk(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve the path spec to the array it names and the per-element id field, so ids and metadata
 *  can never disagree about which array they were read from. */
function locateArray(json: unknown, path: string | null | undefined): { arr: unknown[]; field: string } | null {
  const spec = (path && path.trim()) || DEFAULT_PATH;
  const marker = spec.indexOf('[]');

  let arr: unknown;
  let field: string;
  if (marker === -1) {
    // No `[]` — treat the whole path as pointing at the array itself.
    arr = walk(json, spec);
    field = '';
  } else {
    const arrayPath = spec.slice(0, marker).replace(/\.$/, '');
    field = spec.slice(marker + 2).replace(/^\./, '');
    arr = arrayPath ? walk(json, arrayPath) : json;
  }

  return Array.isArray(arr) ? { arr, field } : null;
}

/** One model as fetched from a provider's /models listing: the id, plus whatever pricing and
 *  context metadata the response volunteered. Prices are USD per 1M tokens — already converted
 *  from the per-token strings providers like OpenRouter publish. */
export interface FetchedModel {
  id: string;
  name?: string;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  contextWindow?: number;
}

/**
 * Per-token price (string or number) → USD per 1M tokens, rounded to 6 decimals so
 * `0.0000025 → 2.5` exactly rather than trailing float residue.
 *
 * A published `0` is KEPT, and that distinction matters. OpenRouter's `:free` models publish
 * `pricing: { prompt: "0", completion: "0" }` — they are genuinely free, and that is a known
 * price, not a missing one. This used to drop them alongside the `-1` "dynamic pricing" sentinel,
 * on the reasoning that the registry's zero default represented both. It no longer does: a model
 * now carries `pricingSource`, so a harvested 0 records as `harvested` (free, priced, routed
 * normally) while an absent price records as `unset` (unknown, flagged, ranked last). Collapsing
 * the two would have every free model on OpenRouter warn the operator forever and sink to the
 * bottom of cost-based routing — and a warning that fires on healthy config is a warning people
 * learn to ignore.
 *
 * `-1` still yields undefined: dynamic pricing is genuinely not a number we know.
 */
function per1M(raw: unknown): number | undefined {
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function readContextWindow(el: Record<string, unknown>): number | undefined {
  for (const key of ['context_length', 'context_window', 'max_context_length']) {
    const v = el[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

/**
 * Read the models from `json` using `path` (`<array>[].<field>`; see extractModelIds), keeping
 * the metadata a richer response carries: display name, per-model pricing, context window.
 * Elements that aren't objects still yield an id-only entry when the id field resolves; nothing
 * here ever throws on a weird response shape. Duplicates collapse to the first occurrence.
 */
export function extractModelMeta(json: unknown, path: string | null | undefined): FetchedModel[] {
  const located = locateArray(json, path);
  if (!located) return [];
  const { arr, field } = located;

  const out: FetchedModel[] = [];
  const seen = new Set<string>();
  for (const el of arr) {
    const v = field ? walk(el, field) : el;
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const model: FetchedModel = { id };
    if (el !== null && typeof el === 'object') {
      const obj = el as Record<string, unknown>;
      const name = obj.name ?? obj.display_name;
      if (typeof name === 'string' && name.trim()) model.name = name.trim();

      const pricing = obj.pricing;
      if (pricing !== null && typeof pricing === 'object') {
        const p = pricing as Record<string, unknown>;
        const input = per1M(p.prompt);
        const output = per1M(p.completion);
        if (input !== undefined) model.inputCostPer1M = input;
        if (output !== undefined) model.outputCostPer1M = output;
      }

      const ctx = readContextWindow(obj);
      if (ctx !== undefined) model.contextWindow = ctx;
    }
    out.push(model);
  }
  return out;
}

/**
 * Read just the model-id strings from `json` using `path`. The path is `<array>[].<field>`:
 * the part before `[]` locates the array (empty = the root is the array), the part after names the
 * field on each element (empty = the elements are themselves strings). Non-string and blank
 * entries are dropped; duplicates are collapsed, order preserved.
 */
export function extractModelIds(json: unknown, path: string | null | undefined): string[] {
  return extractModelMeta(json, path).map((m) => m.id);
}
