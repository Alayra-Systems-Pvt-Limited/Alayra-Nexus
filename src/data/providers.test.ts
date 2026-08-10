import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS, presetFor, providerDefaultUrl, providerLabel, publishesPricing,
} from './providers';

// This table is data, so its tests are about the invariants a wrong edit would break — not about
// re-typing the values, which would only assert that a copy matches its copy.

describe('the preset table', () => {
  it('has no duplicate slugs', () => {
    const slugs = PROVIDER_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses slugs the admin routes will accept', () => {
    // providers.routes.ts validates the slug shape now that the enum is gone. A preset the
    // dashboard offers but the API rejects would be a dead entry in a dropdown.
    for (const p of PROVIDER_PRESETS) expect(p.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every provider except custom a base URL', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.slug === 'custom') expect(p.baseUrl).toBe('');
      else expect(p.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it('never leaves a URL placeholder undeclared', () => {
    // The inverse is the bug that matters: a URL containing `{...}` with no accountPlaceholder to
    // prompt for it saves cleanly and 404s on the first request, with the placeholder sitting in
    // the URL where nobody looks.
    for (const p of PROVIDER_PRESETS) {
      const urls = [p.baseUrl, p.modelFetchUrl ?? ''].join(' ');
      if (/\{[a-z_]+\}/.test(urls)) {
        expect(p.accountPlaceholder, `${p.slug} has a placeholder but no way to fill it`).toBeDefined();
        expect(urls).toContain(p.accountPlaceholder!.token);
      } else {
        expect(p.accountPlaceholder, `${p.slug} declares a placeholder its URLs do not use`).toBeUndefined();
      }
    }
  });

  it('declares a model-id path for every provider', () => {
    for (const p of PROVIDER_PRESETS) expect(p.modelIdPath).toMatch(/\[\]\./);
  });

  it('claims chat-verified only where a completion was actually obtained', () => {
    // The honest-marketing guard. `verified: 'chat'` is what the README's "N verified providers"
    // counts and what P3's harness re-measures; it may only be set from a real probe. Cerebras is
    // the standing example — its model list works on a free key and every completion is a 402.
    expect(presetFor('cerebras')!.verified).toBe('models');
    expect(presetFor('cerebras')!.note).toMatch(/402|payment/i);

    // Never probed is not the same as broken, and must not read as either.
    expect(presetFor('openai')!.verified).toBeNull();
    expect(presetFor('anthropic')!.verified).toBeNull();

    const chat = PROVIDER_PRESETS.filter((p) => p.verified === 'chat').map((p) => p.slug).sort();
    expect(chat).toEqual(['cloudflare', 'google', 'groq', 'huggingface', 'mistral', 'openrouter']);
  });

  it('says a provider publishes pricing only for the two that do', () => {
    // Harvesting is driven off the response shape, not this flag, but the flag is what the UI uses
    // to explain WHY a model came out unpriced. Overstating it would produce a dashboard that
    // blames the operator for a price the provider never sent.
    const publishing = PROVIDER_PRESETS.filter((p) => p.publishesPricing).map((p) => p.slug).sort();
    expect(publishing).toEqual(['groq', 'openrouter']);
  });

  it('does not restate in a note what a field already says', () => {
    // The dashboard renders the note AND a generated line for `publishesPricing: false`. OpenAI's
    // note used to be "Publishes no pricing in /models…", which put two sentences of the same
    // meaning next to each other the moment the generated line existed. Notes carry what the
    // fields cannot.
    for (const p of PROVIDER_PRESETS) {
      if (p.publishesPricing || !p.note) continue;
      expect(p.note, `${p.slug}'s note repeats publishesPricing`).not.toMatch(/publish/i);
    }
  });

  it('keeps the table notes short enough to be table cells', () => {
    // billingNote and verifyNote render inside a README table cell. `note` is the field for prose;
    // a paragraph in either of these makes a column wide enough to push the others off a phone.
    for (const p of PROVIDER_PRESETS) {
      for (const [field, text] of [['billingNote', p.billingNote], ['verifyNote', p.verifyNote]] as const) {
        if (!text) continue;
        expect(text.length, `${p.slug}'s ${field} belongs in \`note\` at ${text.length} chars`)
          .toBeLessThanOrEqual(60);
        expect(text, `${p.slug}'s ${field} reads as a sentence, not a cell`).not.toMatch(/\.$/);
      }
    }
  });

  it('only explains a verification that is not a completion', () => {
    // verifyNote is rendered only for providers below 'chat'. Setting one on a chat-verified
    // provider is dead data that reads, in the source, as though it were being published.
    for (const p of PROVIDER_PRESETS) {
      if (p.verified === 'chat') {
        expect(p.verifyNote, `${p.slug} is chat-verified — its verifyNote is never rendered`).toBeUndefined();
      }
    }
  });

  it('explains Cerebras being models-only where a reader will see it', () => {
    // "Model list only" says what happened, not whether it is the reader's problem. Cerebras works
    // the moment the account is funded — very different from an endpoint that has moved.
    const cerebras = presetFor('cerebras')!;
    expect(cerebras.verified).toBe('models');
    expect(cerebras.verifyNote).toMatch(/402|fund/i);
  });

  it('keeps the bare sk- prefix out of the distinctive stamps', () => {
    // Every OpenAI-compatible provider copies `sk-` on purpose. Claiming it for anyone would make
    // the paste-check reject valid keys.
    for (const p of PROVIDER_PRESETS) {
      for (const prefix of p.keyPrefixes) {
        // Three is the real floor, not four: HuggingFace stamps `hf_`, which is short but
        // unambiguous. The length bound is only here to catch a one- or two-character "stamp",
        // which could never be evidence of anything.
        expect(prefix.length).toBeGreaterThanOrEqual(3);
        expect(prefix).not.toBe('sk-');
      }
    }
  });

  it('gives no two providers a prefix that could match the same key', () => {
    // issuerOf() resolves ties by longest-match, which is only meaningful when the shorter prefix
    // is a genuine ancestor. Two unrelated providers sharing a stamp would make the check a
    // coin-flip about which one it accuses.
    const all = PROVIDER_PRESETS.flatMap((p) => p.keyPrefixes.map((k) => [p.slug, k] as const));
    for (const [slugA, a] of all) {
      for (const [slugB, b] of all) {
        if (slugA === slugB) continue;
        expect(a.startsWith(b), `${slugA}'s "${a}" collides with ${slugB}'s "${b}"`).toBe(false);
      }
    }
  });
});

describe('lookups', () => {
  it('reads a preset by slug', () => {
    expect(presetFor('groq')?.label).toBe('Groq');
    expect(presetFor('nope')).toBeUndefined();
  });

  it('returns an empty base URL for an unknown provider, not a guessed one', () => {
    // The pre-existing contract, and worth keeping: an empty base makes the pool visibly
    // unroutable. A fallback to some other provider's URL would send the operator's key there.
    expect(providerDefaultUrl('acme-internal-llm')).toBe('');
    expect(providerDefaultUrl('custom')).toBe('');
    expect(providerDefaultUrl('groq')).toBe('https://api.groq.com/openai/v1');
  });

  it('shows an unknown provider under its own slug rather than blank', () => {
    expect(providerLabel('acme-internal-llm')).toBe('acme-internal-llm');
    expect(providerLabel('openrouter')).toBe('OpenRouter');
  });

  it('assumes an unknown provider publishes nothing', () => {
    expect(publishesPricing('acme-internal-llm')).toBe(false);
    expect(publishesPricing('groq')).toBe(true);
  });
});
