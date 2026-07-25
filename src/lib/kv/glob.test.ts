/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { globMatch } from './glob';

// The caller of this matcher is deleteKeys('nexus:*') — the factory reset. A pattern that matches
// too much deletes data that was not asked for, and one that matches too little leaves a "wiped"
// gateway holding sessions and counters. Both directions are asserted throughout.
describe('globMatch — the patterns this codebase actually uses', () => {
  it('matches a prefix wildcard', () => {
    expect(globMatch('nexus:*', 'nexus:rpm:abc')).toBe(true);
    expect(globMatch('nexus:*', 'nexus:')).toBe(true);
    expect(globMatch('nexus:*', 'nexus')).toBe(false);
    expect(globMatch('nexus:*', 'other:rpm:abc')).toBe(false);
  });

  it('matches a deeper prefix without escaping its namespace', () => {
    expect(globMatch('nexus:respcache:*', 'nexus:respcache:a1b2')).toBe(true);
    expect(globMatch('nexus:respcache:*', 'nexus:budget:t1:2026-07')).toBe(false);
  });

  it('anchors at both ends — a match is the whole key, never a substring', () => {
    expect(globMatch('nexus:rpm:abc', 'nexus:rpm:abc')).toBe(true);
    expect(globMatch('rpm', 'nexus:rpm:abc')).toBe(false);
    expect(globMatch('nexus:rpm', 'nexus:rpm:abc')).toBe(false);
  });
});

describe('globMatch — characters that are special to RegExp but literal to glob', () => {
  // A budget key is `nexus:budget:<team>:<period>` and periods carry dots and dashes. If these were
  // passed through unescaped, `.` would match any character and the wrong team's counter could be
  // swept up by a pattern meant for another.
  it('treats a dot as a literal', () => {
    expect(globMatch('nexus:v1.2', 'nexus:v1.2')).toBe(true);
    expect(globMatch('nexus:v1.2', 'nexus:v1X2')).toBe(false);
  });

  it.each(['+', '(', ')', '$', '^', '|', '{', '}'])('treats %s as a literal', (ch) => {
    expect(globMatch(`k${ch}1`, `k${ch}1`)).toBe(true);
    expect(globMatch(`k${ch}1`, 'kX1')).toBe(false);
  });

  it('handles a key full of regex metacharacters', () => {
    const key = 'nexus:budget:team.a+b(c):2026-07';
    expect(globMatch(key, key)).toBe(true);
    expect(globMatch('nexus:budget:*', key)).toBe(true);
  });
});

describe('globMatch — the rest of the glob syntax', () => {
  it('matches exactly one character with ?', () => {
    expect(globMatch('key:?', 'key:1')).toBe(true);
    expect(globMatch('key:?', 'key:12')).toBe(false);
    expect(globMatch('key:?', 'key:')).toBe(false);
  });

  it('matches a character class', () => {
    expect(globMatch('key:[abc]', 'key:b')).toBe(true);
    expect(globMatch('key:[abc]', 'key:d')).toBe(false);
  });

  it('matches a range', () => {
    expect(globMatch('key:[a-c]', 'key:b')).toBe(true);
    expect(globMatch('key:[a-c]', 'key:z')).toBe(false);
  });

  it('matches a negated class', () => {
    expect(globMatch('key:[^abc]', 'key:z')).toBe(true);
    expect(globMatch('key:[^abc]', 'key:a')).toBe(false);
  });

  it('takes an escaped wildcard literally', () => {
    expect(globMatch('key:\\*', 'key:*')).toBe(true);
    expect(globMatch('key:\\*', 'key:anything')).toBe(false);
  });

  it('treats an unterminated [ as a literal rather than swallowing the pattern', () => {
    expect(globMatch('key:[', 'key:[')).toBe(true);
    expect(globMatch('key:[abc', 'key:[abc')).toBe(true);
  });

  it('matches everything with a bare *', () => {
    expect(globMatch('*', 'anything at all')).toBe(true);
    expect(globMatch('*', '')).toBe(true);
  });

  it('matches a key containing a newline — keys are bytes, not lines', () => {
    // Without the `s` flag `.` would refuse to cross a newline, so `*` would not match such a key
    // and a purge would silently leave it behind.
    expect(globMatch('nexus:*', 'nexus:a\nb')).toBe(true);
  });
});
