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

/**
 * Read the list of model-id strings from `json` using `path`. The path is `<array>[].<field>`:
 * the part before `[]` locates the array (empty = the root is the array), the part after names the
 * field on each element (empty = the elements are themselves strings). Non-string and blank
 * entries are dropped; duplicates are collapsed, order preserved.
 */
export function extractModelIds(json: unknown, path: string | null | undefined): string[] {
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

  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  for (const el of arr) {
    const v = field ? walk(el, field) : el;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) seen.add(t);
    }
  }
  return [...seen];
}
