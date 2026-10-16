/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The watch that turns a caller hanging up into an aborted provider call. The end-to-end proof, with
// real sockets on both sides, is services/completionsProxy.disconnect.test.ts; these pin the four
// ways the watch itself can be wrong.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchDeparture } from './clientDeparture';

class FakeResponse extends EventEmitter { destroyed = false; }

describe('watchDeparture', () => {
  it('fires once, on close, and reports the caller gone', () => {
    const res = new FakeResponse();
    const onGone = vi.fn();
    const d = watchDeparture(res, onGone);
    expect(d.gone()).toBe(false);

    res.emit('close');
    res.emit('close');
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(d.gone()).toBe(true);
  });

  it('catches a caller who left before the watch started, when close will never fire again', () => {
    const res = new FakeResponse();
    res.destroyed = true;
    const onGone = vi.fn();
    const d = watchDeparture(res, onGone);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(d.gone()).toBe(true);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('stops watching on release, so the proxy ending the response itself is not a departure', () => {
    const res = new FakeResponse();
    const onGone = vi.fn();
    const d = watchDeparture(res, onGone);
    d.release();
    d.release();
    expect(res.listenerCount('close')).toBe(0);

    res.emit('close');
    expect(onGone).not.toHaveBeenCalled();
    expect(d.gone()).toBe(false);
  });

  it('treats a sink that cannot report a departure as a caller who stays', () => {
    const onGone = vi.fn();
    for (const sink of [undefined, { write() {} }, { once() {} }]) {
      const d = watchDeparture(sink as never, onGone);
      d.release();
      expect(d.gone()).toBe(false);
    }
    expect(onGone).not.toHaveBeenCalled();
  });
});
