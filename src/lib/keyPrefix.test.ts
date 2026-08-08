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

import { describe, expect, it } from 'vitest';
import { issuerOf, keyProviderMismatch, providerLabel, withArticle } from './keyPrefix';

describe('issuerOf', () => {
  it('recognises the providers that stamp their keys', () => {
    expect(issuerOf('sk-ant-api03-abc')).toBe('anthropic');
    expect(issuerOf('sk-or-v1-abc')).toBe('openrouter');
    expect(issuerOf('hf_abcdef')).toBe('huggingface');
    expect(issuerOf('gsk_abcdef')).toBe('groq');
    expect(issuerOf('AIzaSyAbc')).toBe('google');
  });

  it('says nothing about a bare sk- key', () => {
    // OpenAI uses it and every OpenAI-compatible provider copies it deliberately, so it is evidence
    // of almost nothing. Claiming it is OpenAI would reject valid keys for a dozen other services.
    expect(issuerOf('sk-abcdef123456')).toBeNull();
    expect(issuerOf('sk-proj-abcdef')).toBeNull();
  });

  it('says nothing about a key with no recognisable stamp', () => {
    // Mistral, self-hosted gateways, corporate proxies. Unrecognised is not wrong.
    expect(issuerOf('abcdef0123456789abcdef0123456789')).toBeNull();
    expect(issuerOf('')).toBeNull();
  });

  it('prefers the longer prefix when two could match', () => {
    // `sk-or-` must not be shadowed by a shorter rule, or OpenRouter keys become unclassifiable.
    expect(issuerOf('sk-or-v1-xyz')).toBe('openrouter');
  });

  it('ignores surrounding whitespace, because paste adds it', () => {
    expect(issuerOf('  sk-ant-api03-abc  ')).toBe('anthropic');
  });
});

describe('keyProviderMismatch', () => {
  it('refuses a key that unmistakably belongs to another provider', () => {
    const problem = keyProviderMismatch('anthropic', 'sk-or-v1-abc');
    expect(problem).toContain('OpenRouter');
    expect(problem).toContain('Anthropic');
  });

  it('names both providers, so the operator knows what to do about it', () => {
    // An error that says only "invalid key" sends someone to check the key. This one has to send
    // them to the right pool instead.
    const problem = keyProviderMismatch('openrouter', 'hf_abc') ?? '';
    expect(problem).toMatch(/HuggingFace/);
    expect(problem).toMatch(/OpenRouter/);
  });

  it('allows a key that matches its pool', () => {
    expect(keyProviderMismatch('anthropic', 'sk-ant-api03-abc')).toBeNull();
    expect(keyProviderMismatch('groq', 'gsk_abc')).toBeNull();
  });

  it('allows an unrecognised key rather than guessing', () => {
    // Mistral has no stable prefix. Hard-failing on anything unfamiliar would start rejecting valid
    // keys the week a provider rotates its format, with no clue why.
    expect(keyProviderMismatch('anthropic', 'abcdef0123456789')).toBeNull();
    expect(keyProviderMismatch('openai', 'sk-abcdef')).toBeNull();
  });

  it('never objects to a custom pool', () => {
    // A custom pool points at an arbitrary base URL — a local llama.cpp, a corporate proxy, another
    // Nexus. Its keys have no format we could be right about.
    expect(keyProviderMismatch('custom', 'sk-ant-api03-abc')).toBeNull();
    expect(keyProviderMismatch('custom', 'hf_abc')).toBeNull();
  });

  it('says nothing about an empty key — that is the schema\'s job', () => {
    expect(keyProviderMismatch('anthropic', '')).toBeNull();
    expect(keyProviderMismatch('anthropic', '   ')).toBeNull();
  });
});

describe('providerLabel', () => {
  it('gives a name an operator recognises', () => {
    expect(providerLabel('openrouter')).toBe('OpenRouter');
    expect(providerLabel('huggingface')).toBe('HuggingFace');
  });

  it('falls back to the slug for a provider it has no name for', () => {
    expect(providerLabel('mistral')).toBe('mistral');
  });
});

describe('withArticle', () => {
  it('uses "an" before a vowel and "a" otherwise', () => {
    expect(withArticle('Anthropic')).toBe('an Anthropic');
    expect(withArticle('OpenRouter')).toBe('an OpenRouter');
    expect(withArticle('Groq')).toBe('a Groq');
    expect(withArticle('Google')).toBe('a Google');
  });

  it('reads correctly in the message an operator actually sees', () => {
    // The first version wrote "This looks like OpenRouter key" and "add a OpenRouter pool", which is
    // what an operator read while something was already going wrong. Caught in the dashboard rather
    // than by a test, so this asserts the whole sentence.
    const problem = keyProviderMismatch('anthropic', 'sk-or-v1-abc') ?? '';
    expect(problem).toContain('This looks like an OpenRouter key');
    expect(problem).toContain('add an OpenRouter pool');
    expect(problem).toContain('paste an Anthropic key');
  });
});
