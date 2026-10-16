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

import { describe, it, expect } from 'vitest';
import { readAnthropicTokens } from './anthropicUsage';

describe('readAnthropicTokens', () => {
  it('adds cache reads and writes to the uncached input, so input means the whole prompt', () => {
    expect(readAnthropicTokens({ input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 42 }))
      .toEqual({ input: 2310, output: 42 });
  });

  it('reads a block with no cache fields as it is', () => {
    expect(readAnthropicTokens({ input_tokens: 7, output_tokens: 3 })).toEqual({ input: 7, output: 3 });
  });

  it('leaves out what was not reported, rather than calling it zero', () => {
    expect(readAnthropicTokens({ output_tokens: 42 })).toEqual({ output: 42 });
    expect(readAnthropicTokens({ input_tokens: null, output_tokens: 'many' })).toEqual({});
    expect(readAnthropicTokens(undefined)).toEqual({});
    expect(readAnthropicTokens([1, 2])).toEqual({});
  });
});
