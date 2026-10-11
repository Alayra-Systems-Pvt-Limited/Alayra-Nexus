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

// The lazy key-value stand-in (P0.5b): nothing is chosen until first use, a host's client wins
// when installed in time, a late install is refused, and calls land on the real client.

import { describe, it, expect, vi } from 'vitest';
import type Redis from 'ioredis';
import { createLazyKv } from './select';

/** A minimal client whose methods report the `this` they ran with. */
function fakeClient(name: string) {
  return {
    name,
    status: 'ready',
    get(this: { name: string }, key: string) { return Promise.resolve(`${this.name}:${key}`); },
    defineCommand(this: Record<string, unknown>, cmd: string) {
      this[cmd] = function (this: { name: string }) { return `${this.name}:${cmd}`; };
    },
  };
}
const asRedis = (c: unknown): Redis => c as Redis;

describe('createLazyKv', () => {
  it('chooses nothing until first use, then chooses once', async () => {
    const fallback = vi.fn(() => asRedis(fakeClient('env')));
    const lazy = createLazyKv(fallback);
    expect(fallback).not.toHaveBeenCalled();

    await expect(lazy.kv.get('k')).resolves.toBe('env:k');
    await lazy.kv.get('k2');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('uses the host client installed before first use, and never builds the fallback', async () => {
    const fallback = vi.fn(() => asRedis(fakeClient('env')));
    const lazy = createLazyKv(fallback);
    lazy.configure(asRedis(fakeClient('host')));

    await expect(lazy.kv.get('k')).resolves.toBe('host:k');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('refuses a client installed after first use, so counters cannot split across two stores', async () => {
    const lazy = createLazyKv(() => asRedis(fakeClient('env')));
    await lazy.kv.get('k');
    expect(() => lazy.configure(asRedis(fakeClient('host')))).toThrow(/already in use/);
  });

  it('refuses a second install', () => {
    const lazy = createLazyKv(() => asRedis(fakeClient('env')));
    lazy.configure(asRedis(fakeClient('a')));
    expect(() => lazy.configure(asRedis(fakeClient('b')))).toThrow(/already in use/);
  });

  it('binds methods to the real client and reads plain properties through', () => {
    const lazy = createLazyKv(() => asRedis(fakeClient('env')));
    const kv = lazy.kv as unknown as { status: string; get: (k: string) => Promise<string> };
    expect(kv.status).toBe('ready');
    const detached = kv.get;                       // called without the stand-in as `this`
    return expect(detached('x')).resolves.toBe('env:x');
  });

  it('reaches a command the client defines after first use (the rate-limit plugin does this)', () => {
    const lazy = createLazyKv(() => asRedis(fakeClient('env')));
    const kv = lazy.kv as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect('rateLimit' in kv).toBe(false);
    kv.defineCommand('rateLimit');
    expect('rateLimit' in kv).toBe(true);
    expect(kv.rateLimit()).toBe('env:rateLimit');
  });

  it('chooses again after reset', async () => {
    const lazy = createLazyKv(() => asRedis(fakeClient('env')));
    await lazy.kv.get('k');
    lazy.reset();
    lazy.configure(asRedis(fakeClient('host')));
    await expect(lazy.kv.get('k')).resolves.toBe('host:k');
  });
});
