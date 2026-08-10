import type { AiModel, PricingSource } from '../api';

// Where a model's prices came from, decided in ONE place for the whole dashboard.
//
// MIRROR of inferPricingSource() in src/services/model.service.ts, and it has to stay one. The
// server infers provenance for entries written before the field existed: a stored non-zero price
// is evidence somebody set it, so it reads as `manual`. Anything on this side that instead treated
// a missing field as `unset` would disagree with the gateway about the same object — flagging a
// priced model as unpriced, and warning about models the router is perfectly happy with.
//
// That is not hypothetical. The published demo serves a fixture written before this field existed;
// read with a plain `?? 'unset'`, every priced model in it wore a "No price" badge and Analytics
// announced that ten models had no price, directly above their prices.

/** Every per-unit price, including the pre-per-1M format still tolerated by the cost helpers. */
const PRICE_FIELDS = [
  'inputCostPer1M', 'outputCostPer1M', 'imagePrice', 'speechPricePer1MChars',
  'transcriptionPrice', 'audioInputPer1M', 'audioOutputPer1M',
  'inputPricePer1k', 'outputPricePer1k',
] as const;

const VALID: readonly string[] = ['unset', 'harvested', 'catalog', 'manual'];

/** The model's stated provenance, or the same inference the server makes when it is absent. */
export function pricingSourceOf(model: Partial<AiModel>): PricingSource {
  const stated = (model as { pricingSource?: string }).pricingSource;
  if (typeof stated === 'string' && VALID.includes(stated)) return stated as PricingSource;

  const record = model as unknown as Record<string, unknown>;
  const priced = PRICE_FIELDS.some((f) => typeof record[f] === 'number' && (record[f] as number) > 0);
  return priced ? 'manual' : 'unset';
}

/**
 * True when this model's cost cannot be computed — unknown, as opposed to zero.
 *
 * A model priced at 0 is NOT unpriced: OpenRouter's `:free` models publish a genuine zero, and
 * warning about those would teach operators to click past the warning that matters.
 */
export function isUnpriced(model: Partial<AiModel>): boolean {
  return pricingSourceOf(model) === 'unset';
}
