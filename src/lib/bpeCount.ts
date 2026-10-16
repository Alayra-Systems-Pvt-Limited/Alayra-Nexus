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

// ── The cl100k token count, in time that grows with the text, not with its square ───────────────
//
// The tokenizer cuts text into pieces (a word, a run of punctuation, a run of whitespace), then
// merges each piece's bytes: the adjacent pair with the lowest rank first, the leftmost on a tie,
// until no pair is a token. js-tiktoken finds that pair by building a string key for every pair
// after every merge, which costs the square of the piece's length: one unbroken run of 2 KiB of
// letters, spaces or punctuation took half a second, 16 KiB half a minute or more, and ordinary
// Chinese about 8 s a MiB, all on the event loop, where every other request waits.
//
// This counts the same tokens from the same data (js-tiktoken's own cl100k ranks and piece pattern)
// by the same rule. Only the search for the next pair changes, the way tiktoken itself does it: a
// scan for a short piece, and for a long one a min-heap of (rank, start) over a linked list of
// parts, so a piece of n bytes costs about n log n. And a pair is looked up by its two token ranks
// in a table built once, never by building and hashing a string. Every count is identical to
// js-tiktoken's (bpeCount.test.ts checks a corpus of real text and thousands of generated strings).
//
// One exception keeps memory bounded. A single piece over SLICE_BYTES (64 KiB with no space, digit
// or punctuation mark to break it, which real text does not have) is merged in slices of that size.
// A cut moves the count a few tokens either way: over 52,500 random cuts in 21 shapes of run, a
// whole run counted between 3 fewer and 2 more tokens than its two parts. So each cut adds
// CUT_MARGIN, 8 tokens, four times the largest drop measured. In every cut measured, the count
// stayed at or above the exact one and at most 11 tokens a cut above it. That is a measurement, not
// a proof: no bound on how far one cut can move a count is known.

/** The shape of js-tiktoken's rank files. */
interface Ranks { pat_str: string; bpe_ranks: string }

interface Cl100k {
  /** Token rank by its bytes, each byte one char of a binary (latin1) string. */
  ranks: Map<string, number>;
  /** The rank of each single byte, which every piece starts as. */
  byteRank: Int32Array;
  pieces: RegExp;
}

/** Pieces up to this many bytes are merged by a scan, as tiktoken does below 100 bytes. */
const SCAN_BYTES = 64;
/** A longer piece is merged in slices of at most this many bytes: ~40 bytes of scratch per byte. */
export const SLICE_BYTES = 64 * 1024;
/** Tokens added per cut. In every cut measured, a sliced piece counted at or above its exact count. */
const CUT_MARGIN = 8;

const NONE = 0x7fffffff;
let data: Cl100k | null = null;

// ── The pair table ──────────────────────────────────────────────────────────────────────────────
//
// Every part of a piece is a token, so whether two neighbours merge, and into what, depends only on
// their two ranks. This table answers that for every pair of tokens whose bytes join into a token
// (open addressing on Int32Arrays), so a merge never builds a string or hashes one.

let pairLeft = new Int32Array(0), pairRight = new Int32Array(0), pairJoined = new Int32Array(0);
let pairMask = 0, pairShift = 0;

const pairSlot = (left: number, right: number): number =>
  Math.imul(Math.imul(left, 0x9e3779b1) ^ right, 0x85ebca6b) >>> pairShift;

/** The rank of the token `left` and `right` join into, or NONE. */
function joined(left: number, right: number): number {
  for (let i = pairSlot(left, right); ; i = (i + 1) & pairMask) {
    const l = pairLeft[i];
    if (l === left && pairRight[i] === right) return pairJoined[i];
    if (l === -1) return NONE;
  }
}

function buildPairs(ranks: Map<string, number>): void {
  const left: number[] = [], right: number[] = [], into: number[] = [];
  for (const [bytes, rank] of ranks) {
    for (let k = 1; k < bytes.length; k++) {
      const a = ranks.get(bytes.substring(0, k)), b = ranks.get(bytes.substring(k));
      if (a !== undefined && b !== undefined) { left.push(a); right.push(b); into.push(rank); }
    }
  }
  let bits = 1;
  while (1 << bits < left.length * 1.6) bits++; // at most 5/8 full
  pairMask = (1 << bits) - 1; pairShift = 32 - bits;
  pairLeft = new Int32Array(1 << bits).fill(-1); pairRight = new Int32Array(1 << bits); pairJoined = new Int32Array(1 << bits);
  for (let e = 0; e < left.length; e++) {
    let i = pairSlot(left[e], right[e]);
    while (pairLeft[i] !== -1) i = (i + 1) & pairMask;
    pairLeft[i] = left[e]; pairRight[i] = right[e]; pairJoined[i] = into[e];
  }
}

function load(): Cl100k {
  // The rank file alone, rather than js-tiktoken's index, which loads every encoding it ships.
  // Required, not imported: the package maps this path with `exports`, which the compiler's
  // CommonJS resolution does not read.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require('js-tiktoken/ranks/cl100k_base') as Ranks;
  const ranks = new Map<string, number>();
  for (const line of src.bpe_ranks.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    const offset = Number.parseInt(fields[1], 10);
    for (let i = 2; i < fields.length; i++) ranks.set(Buffer.from(fields[i], 'base64').toString('latin1'), offset + i - 2);
  }
  buildPairs(ranks);
  const byteRank = new Int32Array(256);
  for (let b = 0; b < 256; b++) byteRank[b] = ranks.get(String.fromCharCode(b)) ?? NONE;
  return { ranks, byteRank, pieces: new RegExp(src.pat_str, 'gu') };
}

/** Load the ranks now rather than at the first count: tokenizer.ts `warmTokenizer` does, at boot. */
export function loadCl100k(): void {
  data ??= load();
}

// ── A short piece: scan the pairs for the lowest rank ───────────────────────────────────────────

const parts = new Int32Array(SCAN_BYTES), pairRanks = new Int32Array(SCAN_BYTES);

function scanMerge(d: Cl100k, bytes: string): number {
  let n = bytes.length;
  for (let i = 0; i < n; i++) parts[i] = d.byteRank[bytes.charCodeAt(i)];
  for (let i = 0; i + 1 < n; i++) pairRanks[i] = joined(parts[i], parts[i + 1]);
  while (n > 1) {
    let best = NONE, at = -1;
    for (let i = 0; i < n - 1; i++) if (pairRanks[i] < best) { best = pairRanks[i]; at = i; }
    if (at < 0) break;
    parts[at] = best;
    parts.copyWithin(at + 1, at + 2, n);
    pairRanks.copyWithin(at + 1, at + 2, n - 1);
    n--;
    if (at < n - 1) pairRanks[at] = joined(best, parts[at + 1]);
    if (at > 0) pairRanks[at - 1] = joined(parts[at - 1], best);
  }
  return n;
}

// ── A long piece: a min-heap of (rank, start) over a linked list of parts ───────────────────────

const POS = 2 ** 32;
let next = new Int32Array(0), prev = new Int32Array(0), token = new Int32Array(0), rankAt = new Int32Array(0);
let heap = new Float64Array(0), size = 0;

function push(key: number): void {
  let i = size++;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (heap[up] <= key) break;
    heap[i] = heap[up]; i = up;
  }
  heap[i] = key;
}

function pop(): number {
  const top = heap[0], last = heap[--size];
  let i = 0;
  for (let child = 1; child < size; child = 2 * i + 1) {
    if (child + 1 < size && heap[child + 1] < heap[child]) child++;
    if (heap[child] >= last) break;
    heap[i] = heap[child]; i = child;
  }
  heap[i] = last;
  return top;
}

/** Tokens left after merging `bytes[from, to)` whole. Exported for the tests' exact counts. */
export function heapMerge(bytes: string, from = 0, to = bytes.length): number {
  const d = data ??= load();
  const n = to - from;
  if (n < 2) return n;
  if (next.length < n) {
    next = new Int32Array(n); prev = new Int32Array(n); token = new Int32Array(n); rankAt = new Int32Array(n);
    heap = new Float64Array(3 * n); // n - 1 first pairs, then at most two per merge
  }
  size = 0;
  for (let i = 0; i < n; i++) { next[i] = i + 1; prev[i] = i - 1; token[i] = d.byteRank[bytes.charCodeAt(from + i)]; }
  for (let i = 0; i + 1 < n; i++) {
    const r = joined(token[i], token[i + 1]);
    rankAt[i] = r;
    if (r !== NONE) push(r * POS + i);
  }
  rankAt[n - 1] = NONE;
  let count = n;
  while (size > 0) {
    const key = pop(), r = Math.floor(key / POS), s = key - r * POS;
    if (rankAt[s] !== r) continue; // stale: the pair at s changed, or s was merged away
    const t = next[s], u = next[t];
    token[s] = r; next[s] = u; if (u < n) prev[u] = s;
    rankAt[t] = -1; count--;
    const right = u < n ? joined(r, token[u]) : NONE;
    rankAt[s] = right; if (right !== NONE) push(right * POS + s);
    const p = prev[s];
    if (p >= 0) {
      const left = joined(token[p], r);
      rankAt[p] = left; if (left !== NONE) push(left * POS + p);
    }
  }
  return count;
}

/** Tokens of one piece over SCAN_BYTES: exact up to SLICE_BYTES, then sliced (see above). */
function longPiece(bytes: string): number {
  if (bytes.length <= SLICE_BYTES) return heapMerge(bytes);
  let total = 0, from = 0;
  while (bytes.length - from > SLICE_BYTES) {
    let to = from + SLICE_BYTES;
    while ((bytes.charCodeAt(to) & 0xc0) === 0x80) to--; // cut between characters, not inside one
    total += heapMerge(bytes, from, to) + CUT_MARGIN;
    from = to;
  }
  return total + heapMerge(bytes, from);
}

/** A piece's UTF-8 bytes as a binary string; an ASCII piece is its own. */
export function utf8Bytes(piece: string): string {
  for (let i = 0; i < piece.length; i++) {
    if (piece.charCodeAt(i) > 0x7f) return Buffer.from(piece, 'utf8').toString('latin1');
  }
  return piece;
}

/**
 * The cl100k token count of `text`: js-tiktoken's `encode(text, [], []).length`, exactly, for any
 * text without a single piece over SLICE_BYTES. The text of a special token, such as
 * `<|endoftext|>`, is counted as the ordinary text it is, as that call counts it. (`encode(text)`
 * refuses such text, which left countTokens to guess a quarter of its length.)
 */
export function countCl100k(text: string): number {
  const d = data ??= load();
  let count = 0;
  d.pieces.lastIndex = 0;
  for (let m = d.pieces.exec(text); m !== null; m = d.pieces.exec(text)) {
    const bytes = utf8Bytes(m[0]);
    if (bytes.length === 1 || d.ranks.has(bytes)) count++;
    else count += bytes.length <= SCAN_BYTES ? scanMerge(d, bytes) : longPiece(bytes);
  }
  return count;
}
