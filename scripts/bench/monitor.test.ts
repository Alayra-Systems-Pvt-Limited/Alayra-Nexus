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
import { foldKey, isRoundTrip, parseMonitorLine } from './monitor';

// Captured verbatim from `redis-cli monitor` against redis:7-alpine while running
// `eval "redis.call('GET','a') redis.call('GET','b') return 1" 0` — one round trip, two internal
// calls. This is the exact shape that was misread as three round trips.
const EVAL = `1786184725.371849 [0 127.0.0.1:60486] "eval" "redis.call('GET','a') redis.call('GET','b') return 1" "0"`;
const LUA_A = '1786184725.371910 [0 lua] "GET" "a"';
const LUA_B = '1786184725.371916 [0 lua] "GET" "b"';

describe('isRoundTrip', () => {
  it('counts a client command', () => {
    expect(isRoundTrip(EVAL)).toBe(true);
  });

  it('does NOT count a call made inside a Lua script', () => {
    // The whole correction rests on this line. If it ever returns true, every round-trip figure the
    // routing benchmark reports silently inflates by the number of redis.call()s in our scripts.
    expect(isRoundTrip(LUA_A)).toBe(false);
    expect(isRoundTrip(LUA_B)).toBe(false);
  });

  it('reports one round trip for a script that made two internal calls', () => {
    expect([EVAL, LUA_A, LUA_B].filter(isRoundTrip)).toHaveLength(1);
  });

  it('ignores the blank lines and the OK banner a capture starts with', () => {
    expect(isRoundTrip('')).toBe(false);
    expect(isRoundTrip('OK')).toBe(false);
  });

  it('counts a unix-socket client, which has no host:port', () => {
    // Redis writes `unix:/path` in the origin field for a socket client. It crossed a boundary and
    // is not `lua`, so it counts — a narrower check that looked for `:` and a port would drop it.
    expect(isRoundTrip('1786184725.1 [0 unix:/var/run/redis.sock] "GET" "a"')).toBe(true);
  });
});

describe('parseMonitorLine', () => {
  it('splits a command from its key', () => {
    expect(parseMonitorLine('1786184725.1 [0 127.0.0.1:1] "get" "nexus:setting:CACHE_ENABLED"'))
      .toEqual({ command: 'get', key: 'nexus:setting:CACHE_ENABLED' });
  });

  it('lowercases the command, so GET and get do not count as two things', () => {
    expect(parseMonitorLine(LUA_A)?.command).toBe('get');
  });

  it('returns null for a line that is not a command', () => {
    expect(parseMonitorLine('OK')).toBeNull();
  });

  it('handles a command with no key', () => {
    expect(parseMonitorLine('1786184725.1 [0 127.0.0.1:1] "ping"')).toEqual({ command: 'ping', key: '' });
  });
});

describe('foldKey', () => {
  it('folds a session hash so a summary does not become a list', () => {
    expect(foldKey(`nexus:sticky:${'a1b2c3d4'.repeat(8)}`)).toBe('nexus:sticky:<hash>');
  });

  it('folds a uuid, whose dashed segments are each too short for the hash rule', () => {
    expect(foldKey('nexus:rpm:9f8e7d6c-1a2b-3c4d-5e6f-708192a3b4c5')).toBe('nexus:rpm:<uuid>');
  });

  it('leaves a setting name alone, because WHICH setting is the question', () => {
    expect(foldKey('nexus:setting:CACHE_ENABLED')).toBe('nexus:setting:CACHE_ENABLED');
  });
});
