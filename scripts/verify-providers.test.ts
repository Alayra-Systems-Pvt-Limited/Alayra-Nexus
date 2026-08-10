import { describe, it, expect, afterEach } from 'vitest';
import { candidates, resolveUrls, redact, NOT_CHAT } from './verify-providers';
import { presetFor, type ProviderPreset } from '../src/data/providers';
import type { FetchedModel } from '../src/lib/modelPath';

// The network half of this harness cannot be unit-tested — that is the point of it. What CAN be
// tested is the part that decided WHICH model to probe, and that part is why the harness's first
// run reported two providers as broken when both were fine. A conformance harness that produces
// false failures is worse than none: the failures get written down as facts.

const m = (...ids: string[]): FetchedModel[] => ids.map((id) => ({ id }));

describe('choosing which model to probe', () => {
  it('matches a preference against a namespaced id', () => {
    // Google lists `models/gemini-…` and accepts either form. Matching on the whole id alone
    // found nothing, fell through to the first model in the list, and reported Google as
    // chat-broken because that first model happened to be closed to new accounts.
    const picked = candidates('google', m('models/gemini-2.5-flash', 'models/gemini-flash-lite-latest'));
    expect(picked[0]).toBe('models/gemini-flash-lite-latest');
  });

  it('skips models that are plainly not chat models', () => {
    // Cloudflare's catalogue is every task type in one list, and the first entry is a speech
    // model. Probing it returned a 400 about a missing `audio` field — a true error to the wrong
    // question, recorded as "Cloudflare does not do chat".
    const picked = candidates('cloudflare', m(
      '@cf/pipecat-ai/smart-turn-v2', '@cf/baai/bge-m3', '@cf/meta/llama-3.2-3b-instruct',
    ));
    expect(picked).toContain('@cf/meta/llama-3.2-3b-instruct');
    expect(picked).not.toContain('@cf/pipecat-ai/smart-turn-v2');
    expect(picked).not.toContain('@cf/baai/bge-m3');
  });

  it('never proposes a model the provider did not list', () => {
    // The original bug in this harness's ancestor: it fell back to the first PREFERRED entry
    // whether or not the provider had it, then reported the resulting 404 as a provider failure.
    const listed = m('some-model-we-did-not-expect');
    expect(candidates('groq', listed)).toEqual(['some-model-we-did-not-expect']);
  });

  it('falls back to the provider\'s own list when every preference has been retired', () => {
    // Preference lists are snapshots. Cloudflare dropped `llama-3.1-8b-instruct-fast` between two
    // runs of this script; a harness that gives up there reports a provider outage that is really
    // a stale constant in its own source.
    const picked = candidates('cloudflare', m('@cf/qwen/qwen2.5-coder-32b-instruct'));
    expect(picked).toEqual(['@cf/qwen/qwen2.5-coder-32b-instruct']);
  });

  it('tries more than one model before concluding the provider will not serve', () => {
    const picked = candidates('mistral', m('a-model', 'b-model', 'c-model', 'd-model', 'e-model'));
    expect(picked.length).toBeGreaterThan(1);
    // …but bounded, so a provider answering 402 for everything costs a handful of calls, not 400.
    expect(picked.length).toBeLessThanOrEqual(4);
  });

  it('puts preferences first and does not repeat them', () => {
    const picked = candidates('groq', m('llama-3.1-8b-instant', 'other-a', 'llama-3.1-8b-instant'));
    expect(picked[0]).toBe('llama-3.1-8b-instant');
    expect(picked.filter((p) => p === 'llama-3.1-8b-instant')).toHaveLength(1);
  });

  it('returns nothing when the provider listed nothing usable', () => {
    expect(candidates('cloudflare', m('@cf/openai/whisper', '@cf/baai/bge-small-en'))).toEqual([]);
  });
});

describe('the not-a-chat-model filter', () => {
  it('catches the shapes real catalogues use', () => {
    for (const id of ['@cf/openai/whisper-tiny', 'text-embedding-3-small', '@cf/baai/bge-m3',
      'tts-1-hd', '@cf/pipecat-ai/smart-turn-v2', 'stable-diffusion-xl', 'jina-reranker-v2']) {
      expect(NOT_CHAT.test(id), `${id} should be filtered out`).toBe(true);
    }
  });

  it('does not catch ordinary chat models', () => {
    // The cost of a greedy filter is silent: the harness would skip the one model that works and
    // report the provider as broken, with nothing in the output pointing at the filter.
    for (const id of ['llama-3.1-8b-instant', 'mistral-small-latest', 'models/gemini-flash-lite-latest',
      '@cf/meta/llama-3.2-3b-instruct', 'inclusionai/ling-3.0-tiny:free', 'gpt-4o-mini',
      'claude-haiku-4-5', 'deepseek-ai/DeepSeek-V4-Flash-0731']) {
      expect(NOT_CHAT.test(id), `${id} should NOT be filtered out`).toBe(false);
    }
  });
});

describe('account-scoped URLs', () => {
  const account = 'PROVIDER_ACCOUNT_CLOUDFLARE';
  const before  = process.env[account];
  afterEach(() => { if (before === undefined) delete process.env[account]; else process.env[account] = before; });

  it('reports the missing variable by name rather than calling a placeholder URL', () => {
    delete process.env[account];
    const { missing } = resolveUrls(presetFor('cloudflare') as ProviderPreset);
    // Naming it is the whole value: a request to a URL containing `{account_id}` fails with a
    // provider-side 404 that says nothing about which local value was absent.
    expect(missing).toBe(account);
  });

  it('substitutes into both the base and the model-fetch URL', () => {
    process.env[account] = 'acct-xyz';
    const { base, models } = resolveUrls(presetFor('cloudflare') as ProviderPreset);
    expect(base).toContain('/accounts/acct-xyz/ai/v1');
    expect(models).toContain('/accounts/acct-xyz/ai/models/search');
    expect(`${base} ${models}`).not.toContain('{account_id}');
  });

  it('leaves a provider with no placeholder untouched', () => {
    const { base, models } = resolveUrls(presetFor('groq') as ProviderPreset);
    expect(base).toBe('https://api.groq.com/openai/v1');
    expect(models).toBe('https://api.groq.com/openai/v1/models');
  });
});

describe('redaction of the committed record', () => {
  const account = 'PROVIDER_ACCOUNT_CLOUDFLARE';
  const before  = process.env[account];
  afterEach(() => { if (before === undefined) delete process.env[account]; else process.env[account] = before; });

  it('takes the account id out of text that quotes a URL', () => {
    // Provider error bodies quote the URL they were called on, so an account-scoped provider leaks
    // its account id through its own 404 text even when the URL field itself is already generic.
    // docs/provider-verification/*.json is committed to a public repository.
    process.env[account] = 'acct-secret-123';
    const out = redact('HTTP 404 from https://api.cloudflare.com/client/v4/accounts/acct-secret-123/ai/v1/models');
    expect(out).not.toContain('acct-secret-123');
    expect(out).toContain('{account_id}');
  });

  it('replaces every occurrence, not just the first', () => {
    // The base URL and the model-fetch URL both carry it, and both can appear in one message.
    process.env[account] = 'acct-secret-123';
    expect(redact('acct-secret-123 and again acct-secret-123')).toBe('{account_id} and again {account_id}');
  });

  it('leaves text alone when no account id is configured', () => {
    delete process.env[account];
    expect(redact('HTTP 500 from https://api.groq.com/openai/v1/models')).toBe('HTTP 500 from https://api.groq.com/openai/v1/models');
  });
});
