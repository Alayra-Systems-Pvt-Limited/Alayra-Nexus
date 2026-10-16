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

import { describe, it, expect, vi, afterEach } from 'vitest';

// Every call into the tokenizer is counted, so a test can prove which count a reservation used.
const encodes = vi.hoisted(() => ({ n: 0 }));
vi.mock('js-tiktoken', async (importOriginal) => {
  const real = await importOriginal<typeof import('js-tiktoken')>();
  return {
    ...real,
    getEncoding: (name: Parameters<typeof real.getEncoding>[0]) => {
      const enc = real.getEncoding(name);
      return { encode: (text: string) => { encodes.n++; return enc.encode(text); } };
    },
  };
});

import {
  countTokens, countMessageTokens, computeReserve, estimateMessageTokens, readTpmEstimate,
} from './tokenizer';
import { estimateTokens } from './tokenEstimate';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('countTokens', () => {
  it('returns 0 for empty input', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns a positive count for real text', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(countTokens('the quick brown fox')).toBe(countTokens('the quick brown fox'));
  });

  it('counts more tokens for longer text', () => {
    expect(countTokens('a'.repeat(400))).toBeGreaterThan(countTokens('a'));
  });
});

describe('countMessageTokens', () => {
  it('never returns less than 1, even for no messages', () => {
    expect(countMessageTokens([])).toBe(1);
  });

  it('counts string content plus per-message overhead', () => {
    expect(countMessageTokens([{ role: 'user', content: 'hello' }])).toBe(countTokens('hello') + 4);
  });

  it('counts text parts in array content', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }];
    expect(countMessageTokens(msgs)).toBe(countTokens('hi there') + 4);
  });

  it('ignores malformed entries without content', () => {
    expect(countMessageTokens([{ role: 'system' }, null, 42])).toBe(1);
  });
});

describe('computeReserve', () => {
  it('reserves input + explicit max_tokens', () => {
    const input = countMessageTokens([{ role: 'user', content: 'hi' }]);
    expect(computeReserve([{ role: 'user', content: 'hi' }], 100, 2048)).toBe(input + 100);
  });

  it('falls back to the default output reserve when max_tokens is missing', () => {
    expect(computeReserve([], undefined, 2048)).toBe(1 + 2048);
  });

  it('treats a non-positive max_tokens as unset', () => {
    expect(computeReserve([], 0, 2048)).toBe(1 + 2048);
  });
});

describe('estimateMessageTokens', () => {
  it('never returns less than 1, even for no messages', () => {
    expect(estimateMessageTokens([])).toBe(1);
  });

  it('estimates string content plus the same per-message overhead', () => {
    expect(estimateMessageTokens([{ role: 'user', content: 'hello' }])).toBe(estimateTokens('hello') + 4);
  });

  it('estimates text parts in array content', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi there' }, { type: 'image_url' }] }];
    expect(estimateMessageTokens(msgs)).toBe(estimateTokens('hi there') + 4);
  });

  it('ignores malformed entries without content', () => {
    expect(estimateMessageTokens([{ role: 'system' }, null, 42])).toBe(1);
  });

  it('never reserves less than the tokenizer counts for a conversation', () => {
    const msgs = [
      { role: 'system', content: 'You are a careful assistant. Answer in the language of the question.' },
      { role: 'user', content: '网关在把请求发送给模型供应商之前会估算令牌数量。' },
      { role: 'assistant', content: '{"tokens":{"in":1234,"out":56},"ok":true}' },
      { role: 'user', content: 'function add(a, b) { return a + b; }' },
    ];
    expect(estimateMessageTokens(msgs)).toBeGreaterThanOrEqual(countMessageTokens(msgs));
  });
});

describe('NEXUS_TPM_ESTIMATE', () => {
  it('defaults to the tokenizer, as before', () => {
    expect(readTpmEstimate(undefined)).toBe('tokenizer');
    expect(readTpmEstimate('')).toBe('tokenizer');
    expect(readTpmEstimate(' Tokenizer ')).toBe('tokenizer');
  });

  it('selects the estimate with "fast", in any case', () => {
    expect(readTpmEstimate('fast')).toBe('fast');
    expect(readTpmEstimate(' FAST ')).toBe('fast');
  });

  it('keeps the tokenizer, and says so, for a value it does not know', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readTpmEstimate('bytes')).toBe('tokenizer');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXUS_TPM_ESTIMATE="bytes" was ignored'));
  });
});

describe('computeReserve — which count it uses', () => {
  const chinese = [{ role: 'user', content: '网关在把请求发送给模型供应商之前会估算令牌数量。'.repeat(40) }];

  /** A fresh copy of the module, loaded under the given environment. */
  async function loadWith(value: string | undefined) {
    vi.stubEnv('NEXUS_TPM_ESTIMATE', value ?? '');
    vi.resetModules();
    return import('./tokenizer');
  }

  it('counts with the tokenizer by default', async () => {
    const mod = await loadWith(undefined);
    encodes.n = 0;
    expect(mod.computeReserve(chinese, 100, 2048)).toBe(mod.countMessageTokens(chinese) + 100);
    expect(encodes.n).toBeGreaterThan(0);
  });

  it('estimates without the tokenizer when NEXUS_TPM_ESTIMATE=fast', async () => {
    const mod = await loadWith('fast');
    encodes.n = 0;
    expect(mod.computeReserve(chinese, 100, 2048)).toBe(mod.estimateMessageTokens(chinese) + 100);
    expect(mod.computeReserve(chinese, undefined, 2048)).toBe(mod.estimateMessageTokens(chinese) + 2048);
    expect(encodes.n).toBe(0);
  });

  it('reserves at least what the tokenizer would have when NEXUS_TPM_ESTIMATE=fast', async () => {
    const mod = await loadWith('fast');
    expect(mod.computeReserve(chinese, 100, 2048)).toBeGreaterThanOrEqual(countMessageTokens(chinese) + 100);
  });
});
