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

// sticky.ts imports the real ioredis client at module load; mock it so no
// connection is attempted. sessionHash itself is pure (crypto only).
vi.mock('./redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));

import { sessionHash, stickyRedisKey } from './sticky';

const msg = (role: string, content: string) => ({ role, content });

describe('sessionHash', () => {
  it('is stable across turns of the same conversation', () => {
    const turn1 = { messages: [msg('system', 'You are helpful'), msg('user', 'Hi')] };
    const turn2 = { messages: [msg('system', 'You are helpful'), msg('user', 'Hi'), msg('assistant', 'Hello'), msg('user', 'More')] };
    expect(sessionHash(turn1)).toBe(sessionHash(turn2));
  });

  it('differs for different conversations', () => {
    const a = { messages: [msg('user', 'Tell me about cats')] };
    const b = { messages: [msg('user', 'Tell me about dogs')] };
    expect(sessionHash(a)).not.toBe(sessionHash(b));
  });

  it('prefers an explicit x-nexus-session header over message content', () => {
    const body = { messages: [msg('user', 'anything')] };
    const withHeader = sessionHash(body, { 'x-nexus-session': 'sess-123' });
    const other      = sessionHash({ messages: [msg('user', 'totally different')] }, { 'x-nexus-session': 'sess-123' });
    expect(withHeader).toBe(other); // header pins regardless of body
    expect(withHeader).not.toBe(sessionHash(body));
  });

  it('falls back to the OpenAI user field when no header is present', () => {
    const a = sessionHash({ messages: [msg('user', 'x')], user: 'u-1' });
    const b = sessionHash({ messages: [msg('user', 'y')], user: 'u-1' });
    expect(a).toBe(b);
  });

  it('returns null when there is nothing to key on', () => {
    expect(sessionHash({ messages: [] })).toBeNull();
    expect(sessionHash({ messages: [msg('user', '   ')] })).toBeNull();
    expect(sessionHash({})).toBeNull();
  });

  it('produces a hex digest, not raw content', () => {
    const h = sessionHash({ messages: [msg('user', 'hello')] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stickyRedisKey', () => {
  it('namespaces sticky entries', () => {
    expect(stickyRedisKey('abc')).toBe('nexus:sticky:abc');
  });
});
