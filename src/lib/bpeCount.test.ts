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

// bpeCount.ts must give js-tiktoken's count, exactly, in time linear in the text. js-tiktoken is the
// reference: the same text goes through both. Its own merge is quadratic in the length of one
// unbroken run, so it is only asked about what it counts in reasonable time; 8 KiB runs are pinned
// to the counts it produced once, offline: 4 to 8 s each.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { countCl100k, heapMerge, utf8Bytes, SLICE_BYTES } from './bpeCount';
import { countMessageTokens, countTokens } from './tokenizer';

const tiktoken = getEncoding('cl100k_base');
const reference = (text: string): number => tiktoken.encode(text).length;
const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const MiB = 1024 * 1024;

/** A seeded generator (mulberry32), so every run draws the same strings. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** At least `n` UTF-16 units drawn from `alphabet`. */
function draw(alphabet: string, n: number, seed = 1): string {
  const chars = Array.from(alphabet), next = rng(seed);
  let out = '';
  while (out.length < n) out += chars[Math.floor(next() * chars.length)];
  return out;
}

/** Whole characters drawn from `alphabet` until they take at least `bytes` bytes of UTF-8. */
function drawBytes(alphabet: string, bytes: number, seed: number): string {
  const chars = Array.from(alphabet), next = rng(seed), out: string[] = [];
  for (let size = 0; size < bytes;) {
    const char = chars[Math.floor(next() * chars.length)];
    out.push(char);
    size += Buffer.byteLength(char);
  }
  return out.join('');
}

/** The first `bytes` bytes of `text` repeated, as text. */
function fill(text: string, bytes: number): string {
  let out = text;
  while (Buffer.byteLength(out) < bytes) out += out;
  return Buffer.from(out).subarray(0, bytes).toString();
}

const HAN = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + i * 9)).join('');
/** Each draw from one of these is a single piece to the pre-tokenizer: the shapes that were slow. */
const RUNS: Record<string, string> = {
  letters: 'abcdefghijklmnopqrstuvwxyz',
  punctuation: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
  spaces: ' ',
  equals: '=',
  newlines: '\n',
  whitespace: ' \t\n',
  han: HAN,
  emoji: '😀🚀👍🔥✨🎉',
};

const samples = JSON.parse(read('src/lib/__fixtures__/token-corpus.json')) as Record<string, string | string[]>;

/** Real text: the repository's documents, data and code, two dependency files, and the fixture. */
function corpus(): [string, string][] {
  const files = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package-lock.json', 'Dockerfile',
    'docker-compose.yml', 'eslint.config.mjs', 'prisma/schema.prisma', 'prisma/sqlite-schema.sql',
    'src/lib/__fixtures__/provider-usage.json', 'src/lib/tokenEstimate.ts', 'src/server.ts', 'web/src/api.ts'];
  for (const dir of ['docs', 'docs/provider-verification']) {
    for (const name of readdirSync(resolve(ROOT, dir))) if (/\.(md|json)$/.test(name)) files.push(`${dir}/${name}`);
  }
  const out: [string, string][] = files.map((f) => [f, read(f)]);
  // Minified JavaScript and a real base64 blob, from the Prisma client the gateway installs.
  out.push(['minified', read('node_modules/@prisma/client/runtime/client.js').slice(0, 131072)]);
  out.push(['base64', read('node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.js').slice(0, 65536)]);
  // Every string in the recorded provider answers, as a chat would carry them.
  for (const f of files.filter((name) => name.startsWith('docs/provider-verification/'))) {
    const strings: string[] = [];
    JSON.parse(read(f), (_key, value: unknown) => { if (typeof value === 'string') strings.push(value); return value; });
    out.push([`${f} strings`, strings.join('\n')]);
  }
  for (const [name, text] of Object.entries(samples)) {
    if (typeof text === 'string') out.push([name, text], [`${name} x20`, text.repeat(20)]);
  }
  return out;
}

describe('countCl100k — the count js-tiktoken gives', () => {
  it('on real text: documents, JSON, code, minified JavaScript, base64, 10 scripts, emoji', () => {
    let bytes = 0;
    for (const [name, text] of corpus()) {
      expect(countCl100k(text), name).toBe(reference(text));
      bytes += Buffer.byteLength(text);
    }
    expect(bytes).toBeGreaterThan(MiB); // a corpus that silently shrank would prove little
  }, 120_000);

  it('on 4,000 generated strings over every kind of character the pre-tokenizer tells apart', () => {
    // Combining accent, zero-width space, no-break and ideographic spaces, and two lone surrogates.
    const odd = String.fromCharCode(0x301, 0x200b, 0xa0, 0x3000, 0xdfff, 0xd800);
    const mixed = `abcXYZéßжא文字かな한😀👍🏽0129 \t\n\r!?.,'"<|>_-=+/\\{}[]#@~\`$%^&*()${odd}`;
    const next = rng(7);
    for (let i = 0; i < 4000; i++) {
      let text = draw(mixed, 1 + Math.floor(next() * 120), i);
      // Every 13th string carries a run long enough for the heap merge (over 64 bytes).
      if (i % 13 === 0) text += draw(Object.values(RUNS)[i % 8], 30 + Math.floor(next() * 150), i);
      expect(countCl100k(text), JSON.stringify(text)).toBe(reference(text));
    }
  }, 120_000);

  it('on one unbroken run of each shape that was slow, 1,000 characters long', () => {
    for (const [shape, alphabet] of Object.entries(RUNS)) {
      const text = draw(alphabet, 1000);
      expect(countCl100k(text), shape).toBe(reference(text));
    }
  }, 60_000);

  it('on 8 KiB runs, against the counts js-tiktoken produced offline', () => {
    const PINNED: Record<string, number> = {
      letters: 4447, punctuation: 5449, spaces: 64, equals: 128, newlines: 256, whitespace: 2629, han: 6337, emoji: 5682,
    };
    for (const [shape, alphabet] of Object.entries(RUNS)) {
      expect(countCl100k(fill(draw(alphabet, 8192), 8192)), shape).toBe(PINNED[shape]);
    }
  });

  it('refuses a special token as js-tiktoken does, so countTokens keeps its fallback', () => {
    const text = 'before <|endoftext|> after';
    expect(() => reference(text)).toThrow();
    expect(() => countCl100k(text)).toThrow();
    expect(countTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});

describe('countCl100k — time linear in the text', () => {
  // About 0.1 s each on the development machine; js-tiktoken needed hours for the runs.
  it('counts 1 MiB of any shape in under 2 s', () => {
    const shapes = Object.entries(RUNS).map(([shape, alphabet]): [string, string] => [shape, fill(draw(alphabet, MiB), MiB)]);
    shapes.push(
      ['one-character pieces', fill('1a', MiB)],
      ['base64-like', fill(draw('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', MiB), MiB)],
      ['Chinese prose', fill(samples.chinese as string, MiB)],
      ['English prose', fill(read('README.md'), MiB)],
    );
    for (const [shape, text] of shapes) {
      const started = performance.now();
      countCl100k(text);
      expect(performance.now() - started, shape).toBeLessThan(2000);
    }
  }, 120_000);

  it('counts a 16 KiB run in under 0.2 s (js-tiktoken: half a minute or more)', () => {
    for (const [shape, alphabet] of Object.entries(RUNS)) {
      const text = fill(draw(alphabet, 16384), 16384);
      const started = performance.now();
      countCl100k(text);
      expect(performance.now() - started, shape).toBeLessThan(200);
    }
  });

  it('counts 35,000 one-word messages (a 1 MiB chat body) in under 1 s', () => {
    const messages = Array.from({ length: 35_000 }, (_, i) => ({ role: 'user', content: `word${i}` }));
    const started = performance.now();
    countMessageTokens(messages);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('countCl100k — one piece longer than SLICE_BYTES', () => {
  /** One piece cut `cuts` times, and its exact count: the same bytes merged whole. */
  function longRun(alphabet: string, seed: number, cuts: number) {
    const text = drawBytes(alphabet, cuts * SLICE_BYTES + 1000, seed);
    return { text, exact: heapMerge(utf8Bytes(text)) };
  }

  it('never counts below the exact count, and at most 11 tokens a cut above it', () => {
    // [shape, seed, cuts]. Without the per-cut margin, each one-cut run here counts one token LOW;
    // without it, letters 2 and punctuation 8 count 2 and 3 tokens HIGH, the most measured.
    const alphabets: Record<string, string> = { ...RUNS, ab: 'ab' };
    const cases: [string, number, number][] = [
      ['letters', 13, 1], ['letters', 17, 1], ['punctuation', 19, 1], ['punctuation', 25, 1], ['ab', 26, 1],
      ['letters', 2, 4], ['punctuation', 8, 4], ['han', 1, 4], ['emoji', 1, 4], ['spaces', 1, 4], ['equals', 1, 4],
      ['newlines', 1, 4],
    ];
    for (const [shape, seed, cuts] of cases) {
      const { text, exact } = longRun(alphabets[shape], seed, cuts);
      const count = countCl100k(text);
      expect(count, `${shape} seed ${seed}`).toBeGreaterThanOrEqual(exact);
      expect(count - exact, `${shape} seed ${seed}`).toBeLessThanOrEqual(cuts * 11);
    }
  }, 60_000);

  it('keeps its working memory bounded however long the piece', () => {
    const text = draw(RUNS.letters, 4 * MiB, 3);
    const before = process.memoryUsage().arrayBuffers;
    countCl100k(text);
    // Merged whole, a 4 MiB piece needs about 144 MiB of scratch; sliced, under 3 MiB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * MiB);
  }, 60_000);
});
