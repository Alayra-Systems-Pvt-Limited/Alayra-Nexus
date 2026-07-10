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

// responseCache imports the Redis client at load; mock it (the pure functions
// under test never touch it, but the import must not construct a real client).
vi.mock('./redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));

import {
  isCacheable, responseCacheKey, cacheRedisKey, toCompletionJson,
  buildFromCompletion, buildFromStream, extractStreamContent,
} from './responseCache';
import { SHARED_NAMESPACE } from './scope';

const msg = (role: string, content: string) => ({ role, content });

describe('isCacheable', () => {
  it('requires at least one message', () => {
    expect(isCacheable({ messages: [msg('user', 'hi')] })).toBe(true);
    expect(isCacheable({ messages: [] })).toBe(false);
    expect(isCacheable({})).toBe(false);
  });

  it('refuses multi-choice requests (the cache holds one choice)', () => {
    expect(isCacheable({ messages: [msg('user', 'hi')], n: 3 })).toBe(false);
    expect(isCacheable({ messages: [msg('user', 'hi')], n: 1 })).toBe(true);
  });
});

describe('responseCacheKey', () => {
  const base = { messages: [msg('user', 'hello')], temperature: 0 };

  it('is stable for identical requests', () => {
    expect(responseCacheKey({ ...base })).toBe(responseCacheKey({ ...base }));
  });

  it('ignores stream, user, and model aliases (they route the same)', () => {
    const a = responseCacheKey({ ...base, model: 'alayra-nexus-1', stream: true,  user: 'u1' });
    const b = responseCacheKey({ ...base, model: 'kinetic-nexus-1', stream: false, user: 'u2' });
    expect(a).toBe(b);
  });

  it('changes when messages or generation params change', () => {
    expect(responseCacheKey(base)).not.toBe(responseCacheKey({ messages: [msg('user', 'HELLO')], temperature: 0 }));
    expect(responseCacheKey(base)).not.toBe(responseCacheKey({ ...base, temperature: 0.7 }));
    expect(responseCacheKey(base)).not.toBe(responseCacheKey({ ...base, max_tokens: 100 }));
  });

  it('produces a hex digest and a namespaced Redis key', () => {
    const k = responseCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheRedisKey(k)).toBe(`nexus:respcache:${k}`);
  });

  // Phase 5.5: without this partition, a response paid for by one team's private
  // BYOK key would be replayed from Redis to another team, or to the shared pool.
  describe('scope namespacing (BYOK isolation)', () => {
    it('defaults to the shared namespace', () => {
      expect(responseCacheKey(base)).toBe(responseCacheKey(base, SHARED_NAMESPACE));
    });

    it('never lets two teams share an entry for an identical request', () => {
      const a = responseCacheKey(base, 'team:aaa');
      const b = responseCacheKey(base, 'team:bbb');
      expect(a).not.toBe(b);
    });

    it('never lets a team read or write the shared pool entry', () => {
      expect(responseCacheKey(base, 'team:aaa')).not.toBe(responseCacheKey(base, SHARED_NAMESPACE));
    });

    it('still de-duplicates identical requests within one team', () => {
      expect(responseCacheKey({ ...base }, 'team:aaa')).toBe(responseCacheKey({ ...base }, 'team:aaa'));
    });
  });
});

describe('buildFromCompletion', () => {
  it('extracts content, usage, and provider', () => {
    const data = {
      id: 'cmpl-1', created: 42, model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    const c = buildFromCompletion(data, 'openai');
    expect(c).not.toBeNull();
    expect(c!.content).toBe('hi there');
    expect(c!.provider).toBe('openai');
    expect(c!.promptTokens).toBe(5);
    expect(c!.completionTokens).toBe(2);
  });

  it('does not cache a tool-call-only / empty response', () => {
    expect(buildFromCompletion({ choices: [{ message: { role: 'assistant', tool_calls: [{}] } }] }, 'openai')).toBeNull();
    expect(buildFromCompletion({ choices: [{ message: { role: 'assistant', content: '' } }] }, 'openai')).toBeNull();
    expect(buildFromCompletion({ choices: [] }, 'openai')).toBeNull();
  });
});

describe('extractStreamContent / buildFromStream', () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":", world"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n\n');

  it('assembles delta content across chunks (JSON-parsed, escaping-safe)', () => {
    expect(extractStreamContent(sse)).toBe('Hello, world');
  });

  it('preserves escaped characters in content', () => {
    const s = 'data: {"choices":[{"delta":{"content":"line1\\nline2"}}]}\n\ndata: [DONE]';
    expect(extractStreamContent(s)).toBe('line1\nline2');
  });

  it('builds a cache entry with the assembled content and passed token counts', () => {
    const c = buildFromStream(sse, 'alayra-nexus-1', 'anthropic', 8, 3);
    expect(c.content).toBe('Hello, world');
    expect(c.provider).toBe('anthropic');
    expect(c.promptTokens).toBe(8);
    expect(c.completionTokens).toBe(3);
  });
});

describe('toCompletionJson (replay shape)', () => {
  it('reconstructs an OpenAI chat.completion', () => {
    const json = toCompletionJson({
      id: 'x', created: 1, model: 'alayra-nexus-1', provider: 'openai',
      content: 'cached answer', finishReason: 'stop', promptTokens: 4, completionTokens: 6,
    }) as { object: string; choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message.content).toBe('cached answer');
    expect(json.usage.total_tokens).toBe(10);
  });
});
