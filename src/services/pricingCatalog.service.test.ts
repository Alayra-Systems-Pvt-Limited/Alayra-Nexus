import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { lookupPricing, matchPricing, getPricingCatalog } from './pricingCatalog.service';

interface Case {
  why: string;
  modelString: string;
  provider?: string;
  expect: string | null;
  crossProvider?: boolean;
}
interface Fixtures {
  catalog: { match: string; provider: string; displayName: string; capabilities: string[] }[];
  cases: Case[];
}

// The same file the dashboard's own test reads. See shared/pricingMatch.fixtures.json.
const FIXTURES: Fixtures = JSON.parse(
  readFileSync(resolve(__dirname, '../../shared/pricingMatch.fixtures.json'), 'utf8'),
);
const FIXTURE_CATALOG = FIXTURES.catalog as unknown as Parameters<typeof matchPricing>[2];

describe('pricingCatalog', () => {
  it('exposes a non-empty catalog', () => {
    expect(getPricingCatalog().length).toBeGreaterThan(0);
  });

  it('carries per-modality prices where they apply', () => {
    expect(lookupPricing('tts-1')?.speechPricePer1MChars).toBe(15);
    expect(lookupPricing('gpt-4o-realtime-preview')?.audioOutputPer1M).toBe(80);
  });

  it('still resolves the real prices behind the shared fixtures', () => {
    expect(lookupPricing('gpt-4o')?.inputCostPer1M).toBe(2.5);
    expect(lookupPricing('gpt-4o-mini')?.inputCostPer1M).toBe(0.15);
    expect(lookupPricing('claude-3-5-sonnet-20241022')?.outputCostPer1M).toBe(15);
  });

  // ── The shared contract ─────────────────────────────────────────────────────
  describe('shared matching fixtures', () => {
    it('has fixtures to run', () => {
      expect(FIXTURES.cases.length).toBeGreaterThan(10);
      expect(FIXTURES.catalog.length).toBeGreaterThan(3);
    });

    // Without this, the shared snapshot could drift away from what actually ships and both suites
    // would go on certifying the rule against models the product no longer has.
    it('every fixture catalog entry still exists in the real catalog, same provider', () => {
      const real = new Map(getPricingCatalog().map((e) => [e.match, e.provider]));
      for (const e of FIXTURES.catalog) {
        expect(real.has(e.match), `fixture entry "${e.match}" is gone from src/data/pricingCatalog.ts`).toBe(true);
        expect(real.get(e.match), `fixture entry "${e.match}" changed provider`).toBe(e.provider);
      }
    });

    for (const c of FIXTURES.cases) {
      const label = `${c.modelString.trim() || '(blank)'}${c.provider ? ` @${c.provider}` : ''} → ${c.expect ?? 'null'} — ${c.why}`;
      it(label, () => {
        const hit = matchPricing(c.modelString, c.provider, FIXTURE_CATALOG);
        expect(hit?.entry.match ?? null).toBe(c.expect);
        if (c.crossProvider !== undefined) expect(hit?.crossProvider).toBe(c.crossProvider);
      });
    }
  });

  // The shared fixtures cannot reach this: no two entries in the bundled catalog collide across
  // providers, so "same provider wins" is never actually exercised by them. Left untested it would
  // be another branch that only unit tests can reach — which is how the unpriced-ranks-last claim
  // survived being false for months. A synthetic catalog puts the two in genuine competition.
  describe('provider preference', () => {
    const CATALOG = [
      { match: 'llama-3.3-70b-instruct', provider: 'openrouter', displayName: 'via OpenRouter', capabilities: ['chat' as const], inputCostPer1M: 0.9 },
      { match: 'llama-3.3-70b',          provider: 'groq',       displayName: 'via Groq',       capabilities: ['chat' as const], inputCostPer1M: 0.59 },
    ];

    it('prefers the pool\'s own provider even when another entry is a longer match', () => {
      const hit = matchPricing('llama-3.3-70b-instruct', 'groq', CATALOG);
      expect(hit?.entry.provider).toBe('groq');
      expect(hit?.crossProvider).toBe(false);
    });

    it('takes the longest match when no provider is given', () => {
      expect(matchPricing('llama-3.3-70b-instruct', undefined, CATALOG)?.entry.provider).toBe('openrouter');
    });

    it('falls back across providers, flagged, when the pool\'s provider has no entry', () => {
      const hit = matchPricing('llama-3.3-70b-instruct', 'huggingface', CATALOG);
      expect(hit?.entry.provider).toBe('openrouter');
      expect(hit?.crossProvider).toBe(true);
    });
  });

  it('never crosses providers without saying so', () => {
    // The guarantee the dashboard relies on to word its auto-fill note honestly: whenever the
    // entry's provider differs from the pool's, the flag is set. A silent cross-provider fill puts
    // one vendor's price on another vendor's invoice line.
    for (const entry of getPricingCatalog()) {
      const hit = matchPricing(entry.match, 'some-other-provider');
      if (hit) expect(hit.crossProvider).toBe(true);
    }
  });
});
