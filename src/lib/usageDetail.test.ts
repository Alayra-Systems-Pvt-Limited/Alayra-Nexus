/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Every provider's token kinds, stream and non-stream ───────────────────────────────────────
//
// One fixture per provider format (src/lib/__fixtures__/provider-usage.json says which are recorded
// answers and which are documented shapes). Each is read twice: as a whole answer, the way the
// non-streaming path reads it, and as a stream fed through the tally in small uneven pieces, the
// way the streaming path reads it. The two must agree with each other and with the fixture.

import { describe, it, expect } from 'vitest';
import fixtures from './__fixtures__/provider-usage.json';
import { mergeUsageDetail, readUsageDetail, USAGE_DETAIL_FIELDS } from './usageDetail';
import { createStreamTally } from './streamTally';

interface Format {
  name: string;
  source: string;
  nonStream: Record<string, unknown>;
  stream: string;
  expect: { input: number | null; output: number | null; detail: Record<string, number> };
}
const FORMATS = (fixtures as { formats: Format[] }).formats;

/** Feed a stream in 7-byte pieces, so frames and multi-byte characters split across reads. */
function tally(stream: string) {
  const t = createStreamTally();
  const bytes = new TextEncoder().encode(stream);
  for (let i = 0; i < bytes.length; i += 7) t.push(bytes.slice(i, i + 7));
  t.end();
  return t;
}

describe.each(FORMATS.map((f) => [f.name, f] as const))('%s', (_name, f) => {
  it('non-stream: the whole answer yields exactly the reported kinds', () => {
    expect(readUsageDetail(f.nonStream.usage ?? f.nonStream.usageMetadata)).toEqual(f.expect.detail);
  });

  it('stream: the tally yields the same kinds, and the same input and output as before', () => {
    const t = tally(f.stream);
    expect(t.detail()).toEqual(f.expect.detail);
    expect(t.usage()).toEqual(f.expect.input === null ? null : { input: f.expect.input, output: f.expect.output });
  });
});

describe('every format is covered', () => {
  it('has a fixture for each provider family the task names', () => {
    const names = FORMATS.map((f) => f.name).join(' | ');
    for (const family of ['OpenAI', 'Anthropic', 'DeepSeek', 'Gemini']) expect(names).toContain(family);
  });

  it('exercises every token kind somewhere', () => {
    const seen = new Set(FORMATS.flatMap((f) => Object.keys(f.expect.detail)));
    expect([...seen].sort()).toEqual([...USAGE_DETAIL_FIELDS].sort());
  });
});

describe('readUsageDetail', () => {
  it('returns nothing for a block that is not one', () => {
    for (const v of [undefined, null, 0, 'usage', [], [1, 2]]) expect(readUsageDetail(v)).toEqual({});
  });

  it('keeps a reported zero, which is not the same as nothing reported', () => {
    expect(readUsageDetail({ prompt_tokens_details: { cached_tokens: 0 } })).toEqual({ cachedInputTokens: 0 });
    expect(readUsageDetail({ prompt_tokens: 5 })).toEqual({});
  });

  it('ignores a value no INTEGER column could hold, rather than failing the batch insert', () => {
    const bad = { cached_tokens: -1 };
    expect(readUsageDetail({ prompt_tokens_details: bad, cache_read_input_tokens: 2 })).toEqual({ cachedInputTokens: 2 });
    expect(readUsageDetail({ cache_read_input_tokens: '9' })).toEqual({});
    expect(readUsageDetail({ cache_read_input_tokens: Number.NaN })).toEqual({});
    expect(readUsageDetail({ cache_read_input_tokens: 3_000_000_000 })).toEqual({});
    expect(readUsageDetail({ completion_tokens_details: { reasoning_tokens: 2.6 } })).toEqual({ reasoningTokens: 3 });
  });

  it('never returns a field outside the list, whatever the block carries', () => {
    const d = readUsageDetail({ prompt_tokens_details: { cached_tokens: 1, audio_tokens: 7 }, created_cache_tokens: 4, cost: 1 });
    expect(Object.keys(d)).toEqual(['cachedInputTokens']);
  });
});

describe('mergeUsageDetail', () => {
  it('lets a later report win field by field, and keeps what it leaves out', () => {
    const into = { cachedInputTokens: 10, cacheWriteTokens: 2 };
    expect(mergeUsageDetail(into, { cacheWriteTokens: 3, reasoningTokens: 1 }))
      .toEqual({ cachedInputTokens: 10, cacheWriteTokens: 3, reasoningTokens: 1 });
  });

  it('copies only listed fields, so a stray key cannot reach the database', () => {
    const merged = mergeUsageDetail({}, { reasoningTokens: 1, teamId: 'x' } as never);
    expect(merged).toEqual({ reasoningTokens: 1 });
  });
});
