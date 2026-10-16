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

import { describe, it, expect, vi } from 'vitest';

// Every call into the tokenizer is counted, so a test can prove the estimate never makes one.
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

import { estimateTokens, TOKEN_ESTIMATE_WEIGHTS } from './tokenEstimate';
import { countTokens } from './tokenizer';

/** Real text of every kind the weights must cover. Each one is checked against the tokenizer. */
const SAMPLES: Record<string, string> = {
  english: 'Nexus counts the tokens of every prompt before it picks a provider key, so that a key never runs past the per-minute limit its owner gave it. The count only has to be close, because the provider reports the real number when the answer comes back, and the difference is settled then.',
  code: "export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let lastError: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); } catch (err) { lastError = err; await sleep(2 ** i * 100); }\n  }\n  throw lastError;\n}\n",
  minified: 'function(e,t){return e&&t?e.concat(t):e||t}var n=require("x"),r=n.a(1,2),o=Object.keys(r).map(function(k){return[k,r[k]]});module.exports={n:n,r:r,o:o};',
  json: '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":256,"temperature":0.2,"metadata":{"trace_id":"7f3c9a12","retries":0,"tags":["a","b"]}}',
  chineseSimplified: '网关在把请求发送给模型供应商之前会估算令牌数量。延迟是产品的一部分，所以估算必须又快又不能偏低。',
  chineseTraditional: '閘道在將請求傳送給模型供應商之前，會先估算權杖數量。延遲是產品體驗的一部分，所以估算必須又快又不能偏低。',
  japanese: 'ゲートウェイはリクエストをプロバイダーに送る前にトークン数を見積もります。遅延も製品の一部です。',
  korean: '게이트웨이는 요청을 모델 공급자에게 보내기 전에 토큰 수를 추정합니다. 지연 시간도 제품의 일부입니다.',
  russian: 'Шлюз оценивает количество токенов перед отправкой запроса поставщику модели. Задержка тоже часть продукта.',
  arabic: 'تقدّر البوابة عدد الرموز قبل إرسال الطلب إلى مزوّد النموذج. التأخير جزء من المنتج أيضًا.',
  hindi: 'गेटवे अनुरोध को मॉडल प्रदाता को भेजने से पहले टोकन की संख्या का अनुमान लगाता है। देरी भी उत्पाद का हिस्सा है।',
  greek: 'Η πύλη εκτιμά τον αριθμό των διακριτικών πριν στείλει το αίτημα στον πάροχο του μοντέλου.',
  armenian: 'Դարպասը գնահատում է նշանների քանակը՝ հարցումը մոդելի մատակարարին ուղարկելուց առաջ։',
  georgian: 'კარიბჭე აფასებს ტოკენების რაოდენობას მოთხოვნის მოდელის მომწოდებლისთვის გაგზავნამდე.',
  czech: 'Brána odhaduje počet tokenů ještě předtím, než pošle požadavek poskytovateli modelu. Zpoždění je součástí produktu.',
  emoji: 'Shipped 🚀 tests ✅ docs 📚 thanks 👍🏽🎉 see you 👋',
  uuids: '3f2b8c1e-9d4a-4e7b-8a61-2c5d9e0f1a7b\n0b6e4d2a-7c1f-4a3e-9b85-d4e2f1a0c9b6\ne1d2c3b4-a5f6-4789-8abc-def012345678\n',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
};

/** Four sample prompts (English, code, Chinese, JSON), each one sentence repeated to size. */
const SAMPLE_PROMPTS = {
  english: 'The quick brown fox jumps over the lazy dog while the gateway counts every token of the prompt. ',
  code: 'function add(a, b) { return a + b; } // const x = await fetch(url, { method: "POST" });\n',
  cjk: '网关在把请求发送给模型供应商之前会估算令牌数量。延迟是产品的一部分。日本語のテキストも含みます。',
  json: '{"id":"evt_0001","type":"usage","tokens":{"in":1234,"out":56},"tags":["a","b"],"ok":true},',
};
const fill = (seed: string, bytes: number): string =>
  Buffer.from(seed.repeat(Math.ceil(bytes / Buffer.byteLength(seed)) + 1), 'utf8')
    .subarray(0, bytes).toString('utf8').replace(/�+$/u, '');

/** How far above the tokenizer each sample prompt may land: today 1.38, 1.06, 1.42 and 1.22. */
const CEILING = { english: 1.5, code: 1.2, cjk: 1.55, json: 1.35 };

describe('estimateTokens — errs high, never far', () => {
  it('is 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it.each(Object.entries(SAMPLES))('never counts %s below the tokenizer, nor at twice it', (_kind, text) => {
    const exact = countTokens(text);
    const estimate = estimateTokens(text);
    expect(estimate).toBeGreaterThanOrEqual(exact);
    expect(estimate).toBeLessThan(2 * exact);
  });

  it.each(Object.entries(SAMPLE_PROMPTS))('counts the %s sample prompt high, within its ceiling', (kind, seed) => {
    for (const bytes of [2_048, 16_384]) {
      const text = fill(seed, bytes);
      const ratio = estimateTokens(text) / countTokens(text);
      expect(ratio, `${kind} at ${bytes} B`).toBeGreaterThanOrEqual(1);
      expect(ratio, `${kind} at ${bytes} B`).toBeLessThanOrEqual(CEILING[kind as keyof typeof CEILING]);
    }
  });

  it('holds where bytes / 4 runs low: code, JSON and Chinese', () => {
    // The reason this file exists. A byte divisor under-counts each of these by 20-30 %.
    for (const kind of ['code', 'json', 'cjk'] as const) {
      const text = fill(SAMPLE_PROMPTS[kind], 4_096);
      const exact = countTokens(text);
      expect(Math.ceil(Buffer.byteLength(text) / 4), kind).toBeLessThan(exact);
      expect(estimateTokens(text), kind).toBeGreaterThanOrEqual(exact);
    }
  });

  it('grows in step with the text', () => {
    const one = estimateTokens(SAMPLES.english);
    const ten = estimateTokens(`${SAMPLES.english} `.repeat(10));
    expect(ten).toBeGreaterThanOrEqual(9 * one);
    expect(ten).toBeLessThanOrEqual(11 * one);
  });
});

describe('estimateTokens — whitespace and control characters never count low', () => {
  // Each of these once counted at a fraction of the tokenizer: tab shared the space's run, so a
  // run of " \t" cost almost nothing, and \r rode along with \n at 0.04 a character.
  const crafted: Record<string, string> = {
    'space-tab': ' \t'.repeat(1_000),
    'tab-tab-space': '\t\t '.repeat(700),
    'tab-space': '\t '.repeat(1_000),
    tabs: '\t'.repeat(2_000),
    crlf: '\r\n'.repeat(1_000),
    'lone CR': '\r'.repeat(2_000),
    'CR-CR-LF': '\r\r\n'.repeat(700),
    'tab-CR': '\t\r'.repeat(1_000),
    'space-CR': ' \r'.repeat(1_000),
    'LF-CR': '\n\r'.repeat(1_000),
    'vertical tab and form feed': '\v\f'.repeat(1_000),
    'other control characters': '\u0001\u0002\u001b\u007f'.repeat(500),
  };

  it.each(Object.entries(crafted))('counts %s at or above the tokenizer', (_kind, text) => {
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(countTokens(text));
  });
});

describe('estimateTokens — bounded by the UTF-8 byte count', () => {
  it.each(['a', '!', ' ', '\n', '7', 'é', 'Ж', 'Ա', 'ع', 'अ', 'ა', '中', 'あ', '한', '“', '😀'])(
    'never counts %j above its bytes',
    (ch) => {
      expect(estimateTokens(ch)).toBeGreaterThanOrEqual(1);
      expect(estimateTokens(ch)).toBeLessThanOrEqual(Buffer.byteLength(ch));
    },
  );

  it('counts a lone surrogate as the three bytes UTF-8 writes for it', () => {
    expect(estimateTokens('\ud83d')).toBeLessThanOrEqual(3);
    expect(estimateTokens('\ude00')).toBeLessThanOrEqual(3);
    expect(estimateTokens('a\ud83db')).toBeLessThanOrEqual(5);
  });

  it('never exceeds the bytes of any mix of characters', () => {
    // A seeded generator, so a failure names a string that can be replayed.
    let seed = 42;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const pools = [[0x20, 0x7f], [0x80, 0x800], [0x800, 0xd800], [0xe000, 0x10000], [0x10000, 0x110000]];
    for (let s = 0; s < 300; s++) {
      let text = '';
      for (let i = 0; i < 1 + Math.floor(next() * 40); i++) {
        const [lo, hi] = pools[Math.floor(next() * pools.length)];
        text += String.fromCodePoint(lo + Math.floor(next() * (hi - lo)));
      }
      expect(estimateTokens(text), JSON.stringify(text)).toBeLessThanOrEqual(Buffer.byteLength(text));
    }
  });
});

describe('estimateTokens — the tokenizer stays out of it', () => {
  it('never calls the tokenizer, even for a 128 KB Chinese prompt', () => {
    // The tokenizer takes over a second on this prompt. The estimate must not reach it at all.
    const text = fill(SAMPLE_PROMPTS.cjk, 131_072);
    encodes.n = 0;
    expect(estimateTokens(text)).toBeGreaterThan(Buffer.byteLength(text) / 4);
    expect(encodes.n).toBe(0);
  });

  it('keeps its weights in one frozen constant, with headroom above the fit', () => {
    expect(Object.isFrozen(TOKEN_ESTIMATE_WEIGHTS)).toBe(true);
    expect(TOKEN_ESTIMATE_WEIGHTS.headroom).toBeGreaterThan(1);
  });
});
