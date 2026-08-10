import { GET, type PricingCatalogEntry } from '../api';

// Client access to the bundled pricing catalog behind the editor's "auto-fill". The catalog is
// fetched once and matched locally.
//
// MIRROR: this rule must behave identically to src/services/pricingCatalog.service.ts on the
// server. Two implementations of one rule drift silently — the editor would auto-fill a price the
// gateway would never have chosen. shared/pricingMatch.fixtures.json is the contract: both suites
// run the same cases against the same catalog snapshot, so an implementation that stops satisfying
// it fails on its own side, and changing the rule means changing the fixtures, which fails the other.

export const loadPricingCatalog = () =>
  GET<{ catalog: PricingCatalogEntry[] }>('/admin/models/pricing-catalog').then((r) => r.catalog);

/** A catalog hit, plus whether it had to cross provider lines to find one. A provider's price for
 *  a model is its own — gpt-4o through OpenRouter is not gpt-4o from OpenAI — so a cross-provider
 *  fill is offered but never presented as authoritative. */
export interface PricingMatch {
  entry:         PricingCatalogEntry;
  crossProvider: boolean;
}

/** Lowercase and fold `.` to `-`, so the catalog's `claude-3-5-sonnet` meets OpenRouter's
 *  `claude-3.5-sonnet`, and `gemini-2.0-flash` meets `gemini-2-0-flash-001`. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\./g, '-');

/** The part after the last `/`. Aggregators namespace by vendor — OpenRouter serves
 *  `openai/gpt-4o` — and matching only from position 0 missed every one of them. */
const tail = (s: string) => s.slice(s.lastIndexOf('/') + 1);

/** A prefix counts only when it ends on a boundary, so `gpt-4` cannot claim `gpt-45`. */
function prefixHit(id: string, entryMatch: string): boolean {
  if (id === entryMatch) return true;
  if (!id.startsWith(entryMatch)) return false;
  return !/[a-z0-9]/.test(id.charAt(entryMatch.length));
}

/**
 * Best catalog entry for a model string. When `provider` is given, an entry for that same provider
 * beats an otherwise-better entry from a different one.
 *
 * Preference order: same provider, then a match on the whole id over a match on just the tail,
 * then the longest `match` — so `gpt-4o-mini` never falls through to `gpt-4o`.
 */
export function matchPricing(
  catalog: PricingCatalogEntry[],
  modelString: string,
  provider?: string,
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

/** Best catalog entry for a model string, or null. Kept for callers that do not need provenance. */
export function matchCatalog(
  catalog: PricingCatalogEntry[],
  modelString: string,
  provider?: string,
): PricingCatalogEntry | null {
  return matchPricing(catalog, modelString, provider)?.entry ?? null;
}
