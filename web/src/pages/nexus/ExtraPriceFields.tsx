import type { AiModel } from '../../api';
import { Field, Input, FieldRow, FormNote } from '../../ui';

// The optional prices beyond input and output. Each box is blank unless set, and blank is NOT zero:
// the gateway then uses Anthropic's published cache multipliers (or, for other providers, the input
// price), and a server tool with no price is removed from native requests rather than run unbilled.

export const EXTRA_PRICE_KEYS = [
  'cacheReadCostPer1M', 'cacheWrite5mCostPer1M', 'cacheWrite1hCostPer1M', 'webSearchCostPer1K', 'webFetchCostPer1K',
] as const satisfies ReadonlyArray<keyof AiModel>;

type ExtraPrices = Partial<Pick<AiModel, (typeof EXTRA_PRICE_KEYS)[number]>>;

/** The form's text for each price: the number, or '' when unset. Only keys `src` sets when `onlySet`. */
export function extraText(src: ExtraPrices, onlySet = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of EXTRA_PRICE_KEYS) {
    const v = src[k];
    if (typeof v === 'number') out[k] = String(v);
    else if (!onlySet) out[k] = '';
  }
  return out;
}

/** The registry values for the form's text: a number, or undefined (left out when saved) when blank. */
export function extraValues(text: Record<string, string>): ExtraPrices {
  const out: ExtraPrices = {};
  for (const k of EXTRA_PRICE_KEYS) {
    const v = parseFloat(text[k] ?? '');
    out[k] = text[k]?.trim() && Number.isFinite(v) && v >= 0 ? v : undefined;
  }
  return out;
}

const box = (label: string, hint: string, k: (typeof EXTRA_PRICE_KEYS)[number], values: Record<string, string>, onChange: (k: string, v: string) => void) => (
  <Field label={label} hint={hint}>
    <Input type="number" min={0} step="any" placeholder="default" value={values[k] ?? ''} onInput={(e) => onChange(k, (e.target as HTMLInputElement).value)} />
  </Field>
);

export function ExtraPriceFields({ values, onChange }: { values: Record<string, string>; onChange: (k: string, v: string) => void }) {
  return (
    <>
      <FormNote>Cache and server-tool prices. Leave blank for the default: Anthropic's published cache rates, or the input price for other providers. A server tool with no price here is not offered.</FormNote>
      <FieldRow>
        {box('Cache read', '$ / 1M tokens', 'cacheReadCostPer1M', values, onChange)}
        {box('Cache write, 5 min', '$ / 1M tokens', 'cacheWrite5mCostPer1M', values, onChange)}
        {box('Cache write, 1 h', '$ / 1M tokens', 'cacheWrite1hCostPer1M', values, onChange)}
      </FieldRow>
      <FieldRow>
        {box('Web search', '$ / 1,000 uses', 'webSearchCostPer1K', values, onChange)}
        {box('Web fetch', '$ / 1,000 uses', 'webFetchCostPer1K', values, onChange)}
      </FieldRow>
    </>
  );
}
