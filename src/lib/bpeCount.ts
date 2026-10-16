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
// scan over integer ranks for a short piece, and for a long one a min-heap of (rank, start) over a
// linked list of parts, so a piece of n bytes costs about n log n. Every count is identical to
// js-tiktoken's (bpeCount.test.ts checks a corpus of real text and thousands of generated strings).
//
// One exception keeps memory bounded. A single piece over SLICE_BYTES (64 KiB with no space, digit
// or punctuation mark to break it, which real text does not have) is merged in slices of that size.
// A cut moves the count a few tokens either way: over 52,500 random cuts in 21 shapes of run, a
// whole run counted between 3 fewer and 2 more tokens than its two parts. So each cut adds
// CUT_MARGIN, 8 tokens, four times the worst measured: the count stays at or above the exact one,
// and at most 11 tokens a cut above it.

/** The shape of js-tiktoken's rank files. */
interface Ranks { pat_str: string; special_tokens: Record<string, number>; bpe_ranks: string }

interface Cl100k {
  /** Token rank by its bytes, each byte one char of a binary (latin1) string. */
  ranks: Map<string, number>;
  /** The longest token, in bytes: no longer pair needs a lookup. */
  longest: number;
  pieces: RegExp;
  special: RegExp;
}

/** Pieces up to this many bytes are merged by a scan, as tiktoken does below 100 bytes. */
const SCAN_BYTES = 64;
/** A longer piece is merged in slices of at most this many bytes: ~36 bytes of scratch per byte. */
export const SLICE_BYTES = 64 * 1024;
/** Tokens added per cut, so a sliced piece never counts below its exact count. */
const CUT_MARGIN = 8;

const NONE = 0x7fffffff;
let data: Cl100k | null = null;

function load(): Cl100k {
  // The rank file alone, rather than js-tiktoken's index, which loads every encoding it ships.
  // Required, not imported: the package maps this path with `exports`, which the compiler's
  // CommonJS resolution does not read.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require('js-tiktoken/ranks/cl100k_base') as Ranks;
  const ranks = new Map<string, number>();
  let longest = 0;
  for (const line of src.bpe_ranks.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    const offset = Number.parseInt(fields[1], 10);
    for (let i = 2; i < fields.length; i++) {
      const bytes = Buffer.from(fields[i], 'base64').toString('latin1');
      ranks.set(bytes, offset + i - 2);
      if (bytes.length > longest) longest = bytes.length;
    }
  }
  const escape = (s: string) => s.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
  return {
    ranks, longest,
    pieces: new RegExp(src.pat_str, 'gu'),
    special: new RegExp(Object.keys(src.special_tokens).map(escape).join('|')),
  };
}

/** Load the ranks now rather than at the first count: tokenizer.ts `warmTokenizer` does, at boot. */
export function loadCl100k(): void {
  data ??= load();
}

function rankOf(d: Cl100k, bytes: string, from: number, to: number): number {
  if (to - from > d.longest) return NONE;
  return d.ranks.get(bytes.substring(from, to)) ?? NONE;
}

// ── A short piece: scan the pairs' ranks for the lowest ─────────────────────────────────────────

const starts = new Int32Array(SCAN_BYTES + 1), pairRanks = new Int32Array(SCAN_BYTES + 1);

function scanMerge(d: Cl100k, bytes: string): number {
  const n = bytes.length;
  for (let i = 0; i <= n; i++) starts[i] = i;
  for (let i = 0; i + 1 < n; i++) pairRanks[i] = rankOf(d, bytes, i, i + 2);
  let parts = n;
  while (parts > 1) {
    let best = NONE, at = -1;
    for (let i = 0; i < parts - 1; i++) if (pairRanks[i] < best) { best = pairRanks[i]; at = i; }
    if (at < 0) break;
    starts.copyWithin(at + 1, at + 2, parts + 1);
    pairRanks.copyWithin(at + 1, at + 2, parts - 1);
    parts--;
    if (at < parts - 1) pairRanks[at] = rankOf(d, bytes, starts[at], starts[at + 2]);
    if (at > 0) pairRanks[at - 1] = rankOf(d, bytes, starts[at - 1], starts[at + 1]);
  }
  return parts;
}

// ── A long piece: a min-heap of (rank, start) over a linked list of parts ───────────────────────

const POS = 2 ** 32;
let next = new Int32Array(0), prev = new Int32Array(0), rankAt = new Int32Array(0);
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
    next = new Int32Array(n); prev = new Int32Array(n); rankAt = new Int32Array(n);
    heap = new Float64Array(3 * n); // n - 1 first pairs, then at most two per merge
  }
  size = 0;
  for (let i = 0; i < n; i++) { next[i] = i + 1; prev[i] = i - 1; }
  for (let i = 0; i + 1 < n; i++) {
    const r = rankOf(d, bytes, from + i, from + i + 2);
    rankAt[i] = r;
    if (r !== NONE) push(r * POS + i);
  }
  rankAt[n - 1] = NONE;
  let parts = n;
  while (size > 0) {
    const key = pop(), r = Math.floor(key / POS), s = key - r * POS;
    if (rankAt[s] !== r) continue; // stale: the pair at s changed, or s was merged away
    const t = next[s], u = next[t];
    next[s] = u; if (u < n) prev[u] = s;
    rankAt[t] = -1; parts--;
    const right = u < n ? rankOf(d, bytes, from + s, from + next[u]) : NONE;
    rankAt[s] = right; if (right !== NONE) push(right * POS + s);
    const p = prev[s];
    if (p >= 0) {
      const left = rankOf(d, bytes, from + p, from + u);
      rankAt[p] = left; if (left !== NONE) push(left * POS + p);
    }
  }
  return parts;
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
 * The cl100k token count of `text`: js-tiktoken's `encode(text).length`, exactly, for any text
 * without a single piece over SLICE_BYTES. Throws, as js-tiktoken does, on a special token such
 * as `<|endoftext|>`.
 */
export function countCl100k(text: string): number {
  const d = data ??= load();
  if (d.special.test(text)) throw new Error('The text contains a special token that is not allowed');
  let count = 0;
  d.pieces.lastIndex = 0;
  for (let m = d.pieces.exec(text); m !== null; m = d.pieces.exec(text)) {
    const bytes = utf8Bytes(m[0]);
    if (bytes.length === 1 || d.ranks.has(bytes)) count++;
    else count += bytes.length <= SCAN_BYTES ? scanMerge(d, bytes) : longPiece(bytes);
  }
  return count;
}
