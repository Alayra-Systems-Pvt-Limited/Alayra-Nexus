import { describe, it, expect } from 'vitest';
// Imported, not read from disk: web/tsconfig.json pins `types` to vitest + jest-dom with no
// "node", and CI installs only web/ — so `node:fs` would not typecheck here. Vite resolves the
// JSON directly, which needs neither.
import fixtures from '../../../shared/pricingMatch.fixtures.json';
import { matchPricing, matchCatalog } from './catalog';
import type { PricingCatalogEntry } from '../api';

// The dashboard's half of the shared matching contract. This file and
// src/services/pricingCatalog.service.test.ts read the SAME cases from the SAME file and assert
// the same outcomes, because the rule is implemented twice — once here for local matching against
// the fetched catalog, once on the server. Editing one implementation alone turns the other red.
//
// See shared/pricingMatch.fixtures.json for what each case is defending.

interface Case {
  why: string;
  modelString: string;
  provider?: string;
  expect: string | null;
  crossProvider?: boolean;
}
interface Fixtures {
  catalog: PricingCatalogEntry[];
  cases: Case[];
}

const FIXTURES = fixtures as unknown as Fixtures;

describe('pricing catalog matching (shared contract with the server)', () => {
  it('loaded the shared fixtures', () => {
    expect(FIXTURES.cases.length).toBeGreaterThan(10);
    expect(FIXTURES.catalog.length).toBeGreaterThan(3);
  });

  for (const c of FIXTURES.cases) {
    const label = `${c.modelString.trim() || '(blank)'}${c.provider ? ` @${c.provider}` : ''} → ${c.expect ?? 'null'} — ${c.why}`;
    it(label, () => {
      const hit = matchPricing(FIXTURES.catalog, c.modelString, c.provider);
      expect(hit?.entry.match ?? null).toBe(c.expect);
      if (c.crossProvider !== undefined) expect(hit?.crossProvider).toBe(c.crossProvider);
    });
  }

  it('matchCatalog stays a thin wrapper returning just the entry', () => {
    expect(matchCatalog(FIXTURES.catalog, 'openai/gpt-4o-mini')?.match).toBe('gpt-4o-mini');
    expect(matchCatalog(FIXTURES.catalog, 'nothing-here')).toBeNull();
  });
});
