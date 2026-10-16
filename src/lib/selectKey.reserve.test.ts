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

// A refusal on size is decided on the exact count. The fast estimate runs about a third high on
// English, so an 80,000-token prompt estimates at about 110,000: above a default key's whole
// 100,000-token limit, which would refuse it on an empty window and on every retry. Routing counts
// such a prompt exactly before deciding (TokenReserve in tokenizer.ts), so it is admitted exactly
// as it is today. The same holds below the whole limit on a busy key: a pass that refuses the
// estimate counts exactly and asks once more. Only a refused request pays for the tokenizer.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const state = vi.hoisted(() => {
  delete process.env.NEXUS_TPM_ESTIMATE;
  return { kv: null as null | { eval(...a: unknown[]): Promise<unknown> }, encodes: 0 };
});
vi.mock('./redis', () => ({ redis: { eval: (...a: unknown[]) => state.kv!.eval(...a) } }));
vi.mock('js-tiktoken', async (importOriginal) => {
  const real = await importOriginal<typeof import('js-tiktoken')>();
  return {
    ...real,
    getEncoding: (name: Parameters<typeof real.getEncoding>[0]) => {
      const enc = real.getEncoding(name);
      return { encode: (text: string) => { state.encodes++; return enc.encode(text); } };
    },
  };
});

const NOON = Date.UTC(2026, 7, 11, 12, 0, 30);
const WINDOW = `nexus:tpm:key-1:${Math.floor(NOON / 60_000)}`;
const key = (tpmLimit: number) => ({ id: 'key-1', rpmLimit: 1_000, tpmLimit, maxUsers: 1_000 });

/** One sentence of English the tokenizer reads at about 5 bytes, 19 tokens. */
const SENTENCE = 'The quick brown fox jumps over the lazy dog while the gateway counts every token of the prompt. ';
/** About 80,000 tokens. */
const BIG = [{ role: 'user', content: SENTENCE.repeat(4_150) }];

/** Fresh copies of the modules, loaded with NEXUS_TPM_ESTIMATE set to `mode`, over an empty store. */
async function load(mode: string) {
  vi.stubEnv('NEXUS_TPM_ESTIMATE', mode);
  vi.resetModules();
  const { MemoryKv } = await import('./kv/memory');
  const kv = new MemoryKv(0);
  state.kv = kv;
  return { kv, tokenizer: await import('./tokenizer'), selectKey: await import('./selectKey') };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOON); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('a refusal on size is decided on the exact count', () => {
  it('admits an 80k-token prompt under a 100k limit with fast, exactly as today', async () => {
    const today = await load('');
    const exact = today.tokenizer.planReserve(BIG, 2_048, 2_048);
    expect(exact.tokens).toBeGreaterThan(80_000);
    expect(exact.tokens).toBeLessThan(100_000);
    expect(await today.selectKey.selectAndReserve([key(100_000)], exact, null)).not.toBeNull();
    expect(await today.kv.get(WINDOW)).toBe(String(exact.tokens));

    const fast = await load('fast');
    const plan = fast.tokenizer.planReserve(BIG, 2_048, 2_048);
    expect(plan.tokens, 'the estimate alone is over the whole limit').toBeGreaterThan(100_000);
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).not.toBeNull();
    expect(plan.exact).toBe(true);
    expect(plan.tokens).toBe(exact.tokens);
    expect(await fast.kv.get(WINDOW)).toBe(String(exact.tokens));
  });

  it('still refuses a prompt whose exact count is over the limit, in both modes', async () => {
    const today = await load('');
    expect(await today.selectKey.selectAndReserve([key(50_000)], today.tokenizer.planReserve(BIG, 2_048, 2_048), null)).toBeNull();

    const fast = await load('fast');
    const plan = fast.tokenizer.planReserve(BIG, 2_048, 2_048);
    expect(await fast.selectKey.selectAndReserve([key(50_000)], plan, null)).toBeNull();
    expect(plan.exact, 'it was counted exactly before being refused').toBe(true);
  });

  it('counts exactly when any one candidate’s whole limit is below the estimate', async () => {
    const fast = await load('fast');
    const plan = fast.tokenizer.planReserve(BIG, 2_048, 2_048);
    const small = { ...key(100_000), id: 'key-2' };
    expect(await fast.selectKey.selectAndReserve([key(1_000_000), small], plan, null)).not.toBeNull();
    expect(plan.exact).toBe(true);
  });

  it('never calls the tokenizer with fast while the estimate is under every whole limit', async () => {
    const fast = await load('fast');
    const small = [{ role: 'user', content: 'A short question about routing.' }];
    state.encodes = 0;
    const plan = fast.tokenizer.planReserve(small, 2_048, 2_048);
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).not.toBeNull();
    expect(plan.exact).toBe(false);
    expect(state.encodes).toBe(0);
  });

  it('takes a plain number as it always did', async () => {
    const today = await load('');
    expect(await today.selectKey.selectAndReserve([key(100_000)], 2_500, null)).not.toBeNull();
    expect(await today.kv.get(WINDOW)).toBe('2500');
  });
});

describe('a refusal on a busy key is decided on the exact count too', () => {
  // A 100k key already holding 10k of other traffic, and a 70k-token prompt with max_tokens 2,048.
  // Today: 10,000 + about 72,000 fits. The estimate is under the whole limit, so it is not counted up
  // front, but 10,000 + the estimate does not fit: refused on every retry unless it is recounted.
  const PROMPT = [{ role: 'user', content: SENTENCE.repeat(3_684) }];   // about 70,000 tokens
  const busy = async (mode: string, traffic: number) => {
    const m = await load(mode);
    m.kv.incrby(WINDOW, traffic);
    m.kv.expire(WINDOW, 120);
    return m;
  };

  it('admits a 70k prompt on a 100k key holding 10k, as today', async () => {
    const today = await busy('', 10_000);
    const exact = today.tokenizer.planReserve(PROMPT, 2_048, 2_048).tokens;
    expect(exact).toBeGreaterThan(70_000);
    expect(10_000 + exact).toBeLessThanOrEqual(100_000);
    expect(await today.selectKey.selectAndReserve([key(100_000)], exact, null)).not.toBeNull();

    const fast = await busy('fast', 10_000);
    const plan = fast.tokenizer.planReserve(PROMPT, 2_048, 2_048);
    expect(plan.tokens, 'not counted up front: under the whole limit').toBeLessThanOrEqual(100_000);
    expect(10_000 + plan.tokens, 'the estimate alone would be refused').toBeGreaterThan(100_000);
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).not.toBeNull();
    expect(plan.exact).toBe(true);
    expect(plan.tokens).toBe(exact);
    expect(await fast.kv.get(WINDOW)).toBe(String(10_000 + exact));
  });

  it('still refuses when the exact count does not fit either, and reserves nothing', async () => {
    const fast = await busy('fast', 30_000);
    const plan = fast.tokenizer.planReserve(PROMPT, 2_048, 2_048);
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).toBeNull();
    expect(plan.exact, 'counted exactly before being refused').toBe(true);
    expect(await fast.kv.get(WINDOW)).toBe('30000');
  });

  it('counts once, however many pools refuse it', async () => {
    const fast = await busy('fast', 99_000);
    const plan = fast.tokenizer.planReserve(PROMPT, 2_048, 2_048);
    state.encodes = 0;
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).toBeNull();
    expect(await fast.selectKey.selectAndReserve([key(100_000)], plan, null)).toBeNull();
    expect(state.encodes).toBe(1);
  });
});
