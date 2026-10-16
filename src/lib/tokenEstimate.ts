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

// ── A token count estimated without the tokenizer ─────────────────────────────────────────────────
//
// The tokenizer is slow exactly where prompts are big: 33 ms for 128 KB of English, 67 ms for
// 128 KB of JSON and 1.36 s for 128 KB of Chinese, all spent on the event loop before the request
// is even routed. A TPM reservation does not need that precision, since the provider's own count
// corrects it afterwards, but it should err high: an estimate that runs low lets a key past the
// limit it was given.
//
// Bytes / 4 does not err high. Against cl100k, real text runs from 1 byte a token (Armenian) to
// 4.9 (plain English): minified JavaScript 1.5-2.2, Chinese 2.0-3.0, JSON 2.4-3.2, Czech 2.7,
// Georgian, Gujarati or Kannada under 2. Bytes / 4 counted those up to 75 % low. No single divisor
// fits both ends.
//
// So this counts what the tokenizer cuts text into (runs of letters, groups of digits, punctuation,
// whitespace runs, and characters by script) in one pass, and weighs each. The weights were fitted
// to sit just above the cl100k count on 402 samples of real text: English prose and docs,
// TypeScript, minified JavaScript, shell and YAML, package and lock JSON, IDs, numbers, base64,
// emoji, and 51 languages in 17 scripts. The sum then gets 5 % headroom. On those samples, and on
// 111 held-out ones, it never fell below the tokenizer; its median was 32 % above for English,
// 28-40 % for code, 16-27 % for JSON and 22 % across the other languages. Strings of random
// characters, which no real prompt is, can fall below. It never exceeds the UTF-8 byte count,
// which no token count can.
//
// It is an admission estimate only. Usage rows and money never use it.

/** `[per run, per character]` tokens for one class of character. */
type Cost = readonly [run: number, char: number];

/**
 * Tokens per piece of text, by character class, fitted against cl100k (see above). One constant,
 * so the whole estimate can be audited in one place. A run is a stretch of one class; ASCII
 * letters form one run per word, with a capital after a lowercase letter starting a new one.
 */
export const TOKEN_ESTIMATE_WEIGHTS = Object.freeze({
  lower:    [0.7, 0.15] as Cost,      // a-z
  upper:    [0.7, 0.5] as Cost,       // A-Z
  punct:    [0.15, 0.3] as Cost,      // ASCII punctuation and symbols
  lineBreak: [1.35, 0.04] as Cost,    // \n and \r
  latin:    [1.45, 0.5] as Cost,      // accented Latin letters
  greek:    [0, 1.05] as Cost,
  cyrillic: [1.55, 0.35] as Cost,
  armenian: [1.5, 1.95] as Cost,
  hebrew:   [0, 1.15] as Cost,
  arabic:   [1.8, 0.7] as Cost,       // with Syriac, Thaana and N'Ko
  other2:   [0, 2] as Cost,           // every other two-byte character: its byte count
  indic:    [0, 1.9] as Cost,         // Devanagari to Sinhala
  thai:     [0, 0.9] as Cost,         // with Lao
  georgian: [1.7, 1.95] as Cost,
  hangul:   [0, 1.2] as Cost,
  kana:     [0, 0.85] as Cost,
  han:      [0, 1.4] as Cost,         // Chinese characters, as used in Chinese, Japanese and Korean
  cjkPunct: [0, 2.7] as Cost,         // CJK and full-width punctuation
  genPunct: [0, 1] as Cost,           // typographic quotes, dashes, ellipsis
  other3:   [0, 1.75] as Cost,        // every other three-byte character
  astral:   [0, 3] as Cost,           // beyond the BMP: emoji, rare ideographs
  /** Each group of up to three digits, the most the tokenizer joins. */
  digitGroup: 1.6,
  /** A run of two or more spaces or tabs, and each space in it. A single space joins the next word. */
  spaceRun: 0.9,
  space: 1 / 80,
  /** Applied to the whole sum, for text unlike the samples the weights were fitted on. */
  headroom: 1.05,
});

// Class ids, in the order of CLASSES. 0 is "no class yet" (the start of the text).
const CLASSES = ['lower', 'upper', 'punct', 'lineBreak', 'latin', 'greek', 'cyrillic', 'armenian', 'hebrew',
  'arabic', 'other2', 'indic', 'thai', 'georgian', 'hangul', 'kana', 'han', 'cjkPunct', 'genPunct', 'other3',
  'astral'] as const;
const [LOWER, UPPER, PUNCT, BREAK, LATIN, GREEK, CYRILLIC, ARMENIAN, HEBREW, ARABIC, OTHER2, INDIC, THAI,
  GEORGIAN, HANGUL, KANA, HAN, CJK_PUNCT, GEN_PUNCT, OTHER3, ASTRAL] = CLASSES.map((_, i) => i + 1);
const DIGIT = CLASSES.length + 1, SPACE = CLASSES.length + 2, COUNT = CLASSES.length + 3;

const RUN = new Float64Array(COUNT), CHAR = new Float64Array(COUNT), BYTES = new Float64Array(COUNT).fill(1);
CLASSES.forEach((name, i) => { [RUN[i + 1], CHAR[i + 1]] = TOKEN_ESTIMATE_WEIGHTS[name]; });
for (const c of [LATIN, GREEK, CYRILLIC, ARMENIAN, HEBREW, ARABIC, OTHER2]) BYTES[c] = 2;
for (const c of [INDIC, THAI, GEORGIAN, HANGUL, KANA, HAN, CJK_PUNCT, GEN_PUNCT, OTHER3]) BYTES[c] = 3;
BYTES[ASTRAL] = 4;

const ASCII = new Uint8Array(128).fill(PUNCT);
for (let x = 0x61; x <= 0x7a; x++) ASCII[x] = LOWER;
for (let x = 0x41; x <= 0x5a; x++) ASCII[x] = UPPER;
for (let x = 0x30; x <= 0x39; x++) ASCII[x] = DIGIT;
ASCII[0x20] = SPACE; ASCII[0x09] = SPACE; ASCII[0x0a] = BREAK; ASCII[0x0d] = BREAK;

/** The class of one UTF-16 code unit at or above 0x80. */
function wideClass(x: number): number {
  if (x < 0x800) {
    if (x < 0x250) return LATIN;
    if (x < 0x370) return OTHER2;              // IPA, spacing modifiers, combining marks
    if (x < 0x400) return GREEK;
    if (x < 0x530) return CYRILLIC;
    if (x < 0x590) return ARMENIAN;
    if (x < 0x600) return HEBREW;
    return ARABIC;
  }
  if (x >= 0x4e00 && x < 0xa000) return HAN;
  if (x >= 0xac00 && x < 0xd7b0) return HANGUL;
  if (x >= 0xd800 && x < 0xdc00) return ASTRAL; // a high surrogate: one 4-byte character with the next unit
  if (x >= 0x3040 && x < 0x3100) return KANA;
  if ((x >= 0x3000 && x < 0x3040) || (x >= 0xff00 && x < 0xfff0)) return CJK_PUNCT;
  if ((x >= 0x3400 && x < 0x4dc0) || (x >= 0xf900 && x < 0xfb00)) return HAN;
  if (x >= 0x0900 && x < 0x0e00) return INDIC;
  if (x >= 0x0e00 && x < 0x0f00) return THAI;
  if (x >= 0x10a0 && x < 0x1100) return GEORGIAN;
  if (x >= 0x1100 && x < 0x1200) return HANGUL;  // conjoining jamo
  if (x >= 0x2000 && x < 0x2070) return GEN_PUNCT;
  return OTHER3;
}

/**
 * Estimated cl100k token count of one string, in one pass and without the tokenizer. Errs high on
 * real text (see `TOKEN_ESTIMATE_WEIGHTS`), and never exceeds the string's UTF-8 byte count.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const W = TOKEN_ESTIMATE_WEIGHTS;
  const chars = new Int32Array(COUNT), runs = new Int32Array(COUNT);
  let digitGroups = 0, spaceRuns = 0, spaces = 0, prev = 0, run = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let c = code < 0x80 ? ASCII[code] : wideClass(code);
    if (c === ASTRAL) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) i++;                       // its low surrogate
      else c = OTHER3;                                                // a lone one: UTF-8 writes 3 bytes
    }
    if (c !== prev && !(prev === UPPER && c === LOWER)) {
      if (prev === DIGIT) digitGroups += Math.ceil(run / 3);
      else if (prev === SPACE && run > 1) { spaceRuns++; spaces += run; }
      runs[c]++;
      run = 0;
    }
    run++; chars[c]++; prev = c;
  }
  if (prev === DIGIT) digitGroups += Math.ceil(run / 3);
  else if (prev === SPACE && run > 1) { spaceRuns++; spaces += run; }

  let sum = W.digitGroup * digitGroups + W.spaceRun * spaceRuns + W.space * spaces;
  let bytes = 0;
  for (let c = 1; c < COUNT; c++) {
    sum += RUN[c] * runs[c] + CHAR[c] * chars[c];
    bytes += BYTES[c] * chars[c];
  }
  // At least one token for any text (a lone space is one), and never more than one per byte.
  return Math.min(bytes, Math.max(1, Math.ceil(sum * W.headroom)));
}
