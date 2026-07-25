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

// Redis-style glob matching for the in-memory KV's SCAN MATCH.
//
// Every pattern this codebase passes today is a simple prefix (`nexus:*`,
// `nexus:respcache:*`), and `startsWith` would satisfy all of them. It is implemented properly
// anyway: the moment someone writes `nexus:rpm:?` or a character class, a prefix shortcut starts
// quietly returning the wrong set of keys — and the caller of the wrong set here is
// `deleteKeys('nexus:*')`, the factory reset. A matcher that is subtly too greedy deletes data.
//
// Translating to a RegExp rather than hand-rolling a matcher, because the escaping is where the bugs
// live: every character that is special to RegExp but literal to glob (`.`, `+`, `(`, `$` …) has to
// be neutralised, and a key like `nexus:budget:t1:2026-07` is full of them.

/**
 * Characters RegExp treats specially, which must be neutralised when they are meant literally.
 *
 * `*` and `?` are in this set even though the main loop handles them as wildcards before ever
 * reaching here — because the ESCAPE branch does not. `\*` means a literal asterisk, and leaving it
 * unescaped emits `*` into the RegExp, where it becomes a quantifier on whatever preceded it. The
 * pattern then silently matches the wrong keys rather than failing loudly.
 */
const REGEX_SPECIAL = /[.+*?^${}()|[\]\\]/g;

/**
 * Compile a Redis glob to a RegExp anchored at both ends.
 *
 * Supported, matching Redis: `*` any run, `?` exactly one, `[abc]` / `[a-c]` a class,
 * `[^abc]` a negated class, and `\x` an escaped literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '\\') {
      // An escape takes the next character literally — including `*`, `?` and `[`.
      const next = pattern[++i];
      out += next === undefined ? '\\\\' : next.replace(REGEX_SPECIAL, '\\$&');
      continue;
    }

    if (c === '*') { out += '.*'; continue; }
    if (c === '?') { out += '.';  continue; }

    if (c === '[') {
      // Copy the class through, but find its real end first: an unterminated `[` is a literal in
      // Redis, not a syntax error, and treating it as a class would swallow the rest of the pattern.
      const end = findClassEnd(pattern, i);
      if (end === -1) { out += '\\['; continue; }

      let body = pattern.slice(i + 1, end);
      let negate = false;
      if (body.startsWith('^')) { negate = true; body = body.slice(1); }
      // Inside a class only `\` and `]` need escaping; `.` `+` `$` are already literal there.
      out += `[${negate ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
      i = end;
      continue;
    }

    out += c.replace(REGEX_SPECIAL, '\\$&');
  }

  return new RegExp(`^${out}$`, 's');
}

/** Index of the `]` closing a class opened at `start`, or -1 when there is none. */
function findClassEnd(pattern: string, start: number): number {
  // A `]` in first position is a literal member, so scanning begins after it.
  let i = start + 1;
  if (pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  for (; i < pattern.length; i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] === ']') return i;
  }
  return -1;
}

// Patterns repeat across a scan — `deleteKeys` compiles the same one for every page — so the
// compiled form is kept. Bounded because the cache key is attacker-influenced in principle: a
// pattern comes from a caller, and an unbounded map keyed by caller input is a slow memory leak.
const CACHE_LIMIT = 256;
const cache = new Map<string, RegExp>();

/** True when `key` matches the Redis glob `pattern`. */
export function globMatch(pattern: string, key: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(key);
}
