import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  newestPerProvider, renderTable, claimMismatches, splice, readEvidence,
  BEGIN, END, type EvidenceFile, type Measurement,
} from './providerTable';
import { PROVIDER_PRESETS, type ProviderPreset } from '../../src/data/providers';
import type { Result } from '../verify-providers';

// This table is the most load-bearing claim in the README: it is what a reader decides on. The
// failure this file guards against is not a crash — it is the table quietly asserting something
// nobody measured, which is exactly the state it was in before it was generated.

const result = (slug: string, over: Partial<Result> = {}): Result => ({
  slug, label: slug, status: 'chat', claimed: 'chat', drift: false, notes: [], ...over,
});

const file = (generatedAt: string, results: Result[]): EvidenceFile => ({ generatedAt, results });

const preset = (over: Partial<ProviderPreset> = {}): ProviderPreset => ({
  slug: 'acme', label: 'Acme', baseUrl: 'https://api.acme.test/v1',
  authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id',
  extraHeaders: {}, keyPrefixes: [], publishesPricing: false, verified: 'chat', ...over,
});

describe('picking the evidence behind a row', () => {
  it('takes the most recent run that measured the provider', () => {
    const best = newestPerProvider([
      file('2026-01-01T00:00:00Z', [result('groq', { status: 'chat' })]),
      file('2026-06-01T00:00:00Z', [result('groq', { status: 'unreachable' })]),
    ]);
    expect(best.get('groq')?.result.status).toBe('unreachable');
    expect(best.get('groq')?.date).toBe('2026-06-01');
  });

  it('does not let a run with no key retract an older measurement', () => {
    // THE bug this function exists for. A run only probes providers whose key is on that machine,
    // so the newest FILE is the newest run, not the newest knowledge. Reading the newest file alone
    // would let a maintainer holding one key demote every provider they do not hold a key for —
    // publishing "unverified" on the authority of someone who ran no probe.
    const best = newestPerProvider([
      file('2026-01-01T00:00:00Z', [result('groq', { status: 'chat' })]),
      file('2026-06-01T00:00:00Z', [result('groq', { status: 'skipped' })]),
    ]);
    expect(best.get('groq')?.result.status).toBe('chat');
    expect(best.get('groq')?.date).toBe('2026-01-01');
  });

  it('leaves a provider that was only ever skipped with no evidence at all', () => {
    const best = newestPerProvider([file('2026-01-01T00:00:00Z', [result('openai', { status: 'skipped' })])]);
    expect(best.has('openai')).toBe(false);
  });

  it('does not depend on the order the files are read in', () => {
    const older = file('2026-01-01T00:00:00Z', [result('groq', { status: 'chat' })]);
    const newer = file('2026-06-01T00:00:00Z', [result('groq', { status: 'models' })]);
    expect(newestPerProvider([older, newer]).get('groq')?.result.status).toBe('models');
    expect(newestPerProvider([newer, older]).get('groq')?.result.status).toBe('models');
  });
});

describe('what a row says', () => {
  const measure = (slug: string, over: Partial<Result> = {}, date = '2026-08-10'): Map<string, Measurement> =>
    new Map([[slug, { result: result(slug, over), date }]]);

  it('publishes the date a claim was measured, not just the claim', () => {
    // Without the date, a row verified once in 2026 reads identically in 2028. Staleness has to be
    // visible on the page; nobody opens the evidence directory to check.
    expect(renderTable([preset()], measure('acme'))).toContain('✅ Completion · 2026-08-10');
  });

  it('marks a provider with no evidence as never probed, not as broken', () => {
    const out = renderTable([preset({ verified: null })], new Map());
    expect(out).toContain('⚪ Preset only');
    expect(out).not.toContain('❌ Did not answer');
  });

  it('counts only chat-verified providers in the headline', () => {
    const out = renderTable(
      [preset({ slug: 'a', label: 'A' }), preset({ slug: 'b', label: 'B', verified: 'models' })],
      new Map([
        ['a', { result: result('a', { status: 'chat' }), date: '2026-08-10' }],
        ['b', { result: result('b', { status: 'models', claimed: 'models' }), date: '2026-08-10' }],
      ]),
    );
    expect(out).toContain('**1 providers have served a real completion');
  });

  it('lets the measurement overrule what the preset claims about pricing', () => {
    // The preset is our assertion; the evidence is the provider answering the same question. When
    // a provider stops publishing prices, the README must not keep promising automatic costing.
    const out = renderTable([preset({ publishesPricing: true })], measure('acme', { pricingPublished: false }));
    expect(out).toContain('❌ Set prices yourself');
    expect(out).not.toContain('✅ Yes, per model');
  });

  it('falls back to the preset when nothing measured the pricing question', () => {
    expect(renderTable([preset({ publishesPricing: true })], new Map())).toContain('✅ Yes, per model');
  });

  it('shows the account placeholder in the endpoint rather than a tidied-up URL', () => {
    // An operator reading `api.cloudflare.com/.../ai/v1` cannot tell there is a value they must
    // supply. The literal token is the useful thing.
    const cf = PROVIDER_PRESETS.find((p) => p.slug === 'cloudflare') as ProviderPreset;
    expect(renderTable([cf], new Map())).toContain('{account_id}');
  });

  it('explains a less-than-verified status instead of only labelling it', () => {
    const out = renderTable([preset({ verified: 'models', verifyNote: 'needs a funded account' })],
      measure('acme', { status: 'models', claimed: 'models' }));
    expect(out).toContain('⚠️ Model list only');
    expect(out).toContain('needs a funded account');
  });

  it('does not explain a status that needs no explanation', () => {
    const out = renderTable([preset({ verifyNote: 'needs a funded account' })], measure('acme'));
    expect(out).not.toContain('needs a funded account');
  });

  it('names the priced providers in the prose instead of a hand-typed pair', () => {
    // The sentence "Only Groq and OpenRouter publish prices" was typed once and would have survived
    // a third provider starting to publish them.
    const out = renderTable(
      [preset({ slug: 'a', label: 'Alpha', publishesPricing: true }), preset({ slug: 'b', label: 'Beta' })],
      new Map(),
    );
    expect(out).toContain('Only **Alpha** return per-model prices');
    expect(out).not.toContain('**Beta** return');
  });

  it('puts what works at the top and what was never probed at the bottom', () => {
    const out = renderTable(
      [preset({ slug: 'never', label: 'Never', verified: null }), preset({ slug: 'works', label: 'Works' })],
      new Map([['works', { result: result('works'), date: '2026-08-10' }]]),
    );
    expect(out.indexOf('**Works**')).toBeLessThan(out.indexOf('**Never**'));
  });

  it('gives one date when everything was measured together and a range once it is not', () => {
    const one = renderTable([preset()], measure('acme'));
    expect(one).toContain('measured 2026-08-10.');

    const spread = renderTable(
      [preset({ slug: 'a', label: 'A' }), preset({ slug: 'b', label: 'B' })],
      new Map([
        ['a', { result: result('a'), date: '2026-01-01' }],
        ['b', { result: result('b'), date: '2026-08-10' }],
      ]),
    );
    expect(spread).toContain('measured between 2026-01-01 and 2026-08-10');
  });
});

describe('refusing to launder a hand-edit', () => {
  it('catches a provider promoted in providers.ts since it was measured', () => {
    // The one move the whole chain exists to stop: editing `verified: null` to `'chat'` and letting
    // the generator carry it to the README as though something had measured it.
    const problems = claimMismatches(
      [preset({ verified: 'chat' })],
      new Map([['acme', { result: result('acme', { claimed: null, status: 'models' }), date: '2026-08-10' }]]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('acme');
  });

  it('says nothing when the table and the measurement agree', () => {
    expect(claimMismatches([preset()], new Map([['acme', { result: result('acme'), date: '2026-08-10' }]]))).toEqual([]);
  });

  it('says nothing about a provider that was never measured', () => {
    expect(claimMismatches([preset({ verified: null })], new Map())).toEqual([]);
  });
});

describe('splicing into the README', () => {
  it('replaces only what is between the markers', () => {
    const before = `intro\n${BEGIN}\nold\n${END}\noutro`;
    const after  = splice(before, `${BEGIN}\nnew\n${END}`);
    expect(after).toBe(`intro\n${BEGIN}\nnew\n${END}\noutro`);
  });

  it('refuses a README with no markers rather than guessing where the table goes', () => {
    expect(() => splice('no markers here', `${BEGIN}\nx\n${END}`)).toThrow(/markers/);
  });

  it('is idempotent', () => {
    const block = `${BEGIN}\nx\n${END}`;
    expect(splice(splice(`a\n${block}\nb`, block), block)).toBe(`a\n${block}\nb`);
  });
});

describe('the committed README and the committed evidence', () => {
  const README = readFileSync(resolve(__dirname, '..', '..', 'README.md'), 'utf8');

  it('is what the generator would write today', () => {
    // The same assertion `npm run docs:providers -- --check` makes in CI, run here too so a stale
    // table fails in the fast job as well as the slow one.
    //
    // What it can catch: a hand-edit to the table, a new evidence file committed without
    // regenerating, a preset changed without regenerating. What it cannot catch is the generator
    // being wrong — the committed README came out of the same function. That is what every test
    // above this one is for.
    const lf       = (s: string) => s.replace(/\r\n/g, '\n');
    const measured = newestPerProvider(readEvidence());
    expect(lf(README)).toBe(lf(splice(README, renderTable(PROVIDER_PRESETS, measured))));
  });

  it('rests on evidence that matches what providers.ts claims', () => {
    expect(claimMismatches(PROVIDER_PRESETS, newestPerProvider(readEvidence()))).toEqual([]);
  });
});
