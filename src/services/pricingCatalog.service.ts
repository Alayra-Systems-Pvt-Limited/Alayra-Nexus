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

import { PRICING_CATALOG, type PricingCatalogEntry } from '../data/pricingCatalog';

// Read-only access to the bundled pricing catalog, plus the model-to-entry lookup the editor's
// "auto-fill" uses. Matching is longest-prefix: an exact model string wins, otherwise the most
// specific `match` prefix does (so `gpt-4o-mini` never falls through to `gpt-4o`).
//
// The rule here is mirrored in web/src/lib/catalog.ts, because the dashboard matches locally
// against the catalog it fetched once. shared/pricingMatch.fixtures.json is the contract between
// them: both suites run the same cases against the same catalog snapshot, so an implementation
// that stops satisfying it goes red on its own side. Neither copy can quietly change the rule —
// changing it means changing the fixtures, which immediately fails the other side.

export type { PricingCatalogEntry };

export function getPricingCatalog(): PricingCatalogEntry[] {
  return PRICING_CATALOG;
}

/**
 * A catalog hit, plus whether it had to cross provider lines to find one.
 *
 * `crossProvider` is not a detail. Providers charge different prices for the same model —
 * gpt-4o through OpenRouter is not gpt-4o from OpenAI — so filling one provider's published
 * price into another provider's model produces a number that looks authoritative and is wrong.
 * The match is still returned, because a nearby figure the operator can correct beats an empty
 * field, but the caller is told, so it can say so.
 */
export interface PricingMatch {
  entry:         PricingCatalogEntry;
  crossProvider: boolean;
}

/** Lowercase and fold `.` to `-`, so the catalog's `claude-3-5-sonnet` meets OpenRouter's
 *  `claude-3.5-sonnet`, and `gemini-2.0-flash` meets `gemini-2-0-flash-001`. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\./g, '-');

/** The part after the last `/`. Aggregators namespace by vendor — OpenRouter serves
 *  `openai/gpt-4o`, Hugging Face `deepseek-ai/DeepSeek-V4-Flash`. Matching only from position 0
 *  meant every one of those hundreds of models missed the catalog and stayed unpriced forever. */
const tail = (s: string) => s.slice(s.lastIndexOf('/') + 1);

/** A prefix counts only when it ends on a boundary, so `gpt-4` cannot claim `gpt-45`.
 *  An exact match always counts. */
function prefixHit(id: string, entryMatch: string): boolean {
  if (id === entryMatch) return true;
  if (!id.startsWith(entryMatch)) return false;
  return !/[a-z0-9]/.test(id.charAt(entryMatch.length));
}

/**
 * Best catalog entry for a model string. `provider` is optional; when given, an entry for that
 * same provider always beats an otherwise-better entry from a different one.
 *
 * Preference order: same provider, then a match on the whole id over a match on just the tail,
 * then the longest `match` — so `gpt-4o-mini` never falls through to `gpt-4o`.
 */
export function matchPricing(
  modelString: string,
  provider?: string,
  catalog: PricingCatalogEntry[] = PRICING_CATALOG,
): PricingMatch | null {
  const raw = (modelString || '').trim();
  if (!raw) return null;

  const whole = norm(raw);
  const forms = [whole];
  const t = norm(tail(raw));
  if (t && t !== whole) forms.push(t);

  let best: { entry: PricingCatalogEntry; form: number; len: number; same: boolean } | null = null;
  for (const entry of catalog) {
    const m = norm(entry.match);
    const form = forms.findIndex((id) => prefixHit(id, m));
    if (form === -1) continue;

    const cand = { entry, form, len: entry.match.length, same: !provider || entry.provider === provider };
    const better = !best
      || (cand.same !== best.same ? cand.same
        : cand.form !== best.form ? cand.form < best.form
          : cand.len > best.len);
    if (better) best = cand;
  }

  if (!best) return null;
  return { entry: best.entry, crossProvider: !!provider && best.entry.provider !== provider };
}

/** The catalog entry alone, for callers that do not care where it came from. */
export function lookupPricing(modelString: string, provider?: string): PricingCatalogEntry | null {
  return matchPricing(modelString, provider)?.entry ?? null;
}
