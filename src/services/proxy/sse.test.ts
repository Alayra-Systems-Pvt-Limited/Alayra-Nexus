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
import { cutFrame, eventBoundary } from './sse';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('eventBoundary', () => {
  it('is closed before anything is relayed, and after a whole event', () => {
    const b = eventBoundary();
    expect(b.closed()).toBe(true);
    b.push(bytes('event: ping\ndata: {}\n\n'));
    expect(b.closed()).toBe(true);
    b.push('data: x\r\n\r\n');
    expect(b.closed()).toBe(true);
  });

  it('is open part-way through an event, including when its blank line arrives split', () => {
    const b = eventBoundary();
    b.push(bytes('data: {"type":"content_bl'));
    expect(b.closed()).toBe(false);
    b.push(bytes('ock_delta"}\n'));
    expect(b.closed()).toBe(false);
    b.push(bytes('\n'));
    expect(b.closed()).toBe(true);
    b.push(new Uint8Array());
    expect(b.closed()).toBe(true);
  });
});

describe('cutFrame', () => {
  it('is an Anthropic error event on the native path, and an OpenAI error frame otherwise', () => {
    const frame = cutFrame('idle', 'anthropic');
    expect(frame.startsWith('event: error\ndata: ')).toBe(true);
    expect(JSON.parse(frame.split('data: ')[1])).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(cutFrame('idle')).toMatch(/^data: \{"error"/);
  });
});
