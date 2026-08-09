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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  onShutdown, shutdown, fatal, installCrashHandlers, resetLifecycle, type ShutdownIo,
} from './lifecycle';

/** Records what the real implementation would have done to the process. */
function spyIo(): ShutdownIo & { exits: number[]; warnings: string[] } {
  const exits: number[] = [];
  const warnings: string[] = [];
  return {
    exits,
    warnings,
    exit: (code) => { exits.push(code); },
    warn: (message) => { warnings.push(message); },
  };
}

beforeEach(() => resetLifecycle());

describe('shutdown', () => {
  it('runs every step, in the order they were registered', async () => {
    const order: string[] = [];
    onShutdown('close', async () => { order.push('close'); });
    onShutdown('flush', async () => { order.push('flush'); });
    onShutdown('disconnect', async () => { order.push('disconnect'); });

    await shutdown(0, spyIo());

    // Order is load-bearing: the listener has to close before the buffers it feeds are flushed.
    expect(order).toEqual(['close', 'flush', 'disconnect']);
  });

  it('exits with the code it was given', async () => {
    const io = spyIo();
    await shutdown(0, io);
    expect(io.exits).toEqual([0]);
  });

  // The bug this replaces: shutdown always exited 0, so a crash looked like a deliberate stop and
  // `Restart=on-failure` left the gateway down.
  it('exits non-zero when the wind-down was caused by a crash', async () => {
    const io = spyIo();
    await shutdown(1, io);
    expect(io.exits).toEqual([1]);
  });

  it('keeps going when a step fails, and still exits', async () => {
    const reached: string[] = [];
    onShutdown('flush that fails', async () => { throw new Error('postgres is gone'); });
    onShutdown('disconnect', async () => { reached.push('disconnect'); });

    const io = spyIo();
    await shutdown(0, io);

    // A failed audit flush must not cost the database disconnect behind it.
    expect(reached).toEqual(['disconnect']);
    expect(io.exits).toEqual([0]);
    expect(io.warnings.join('\n')).toContain('postgres is gone');
  });

  it('names the step that failed, so the log says which one', async () => {
    onShutdown('flush buffered audit entries', async () => { throw new Error('nope'); });
    const io = spyIo();
    await shutdown(0, io);
    expect(io.warnings.join('\n')).toContain('flush buffered audit entries');
  });

  it('takes a second signal as "stop waiting" and exits at once', async () => {
    let started = 0;
    let release: (() => void) | null = null;
    onShutdown('slow flush', () => {
      started++;
      return new Promise<void>((resolve) => { release = resolve; });
    });

    const io = spyIo();
    void shutdown(0, io);
    await Promise.resolve();          // let the first call reach the hanging step
    await shutdown(0, io);            // the operator, having stopped waiting

    expect(io.exits).toEqual([0]);    // exited immediately, without a second pass
    expect(started).toBe(1);          // and without re-running the steps
    release?.();
  });
});

describe('the shutdown deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves anyway when a step never finishes', async () => {
    // A drain against a dependency that is down does not fail, it waits — and waiting past the
    // orchestrator's grace period ends in SIGKILL, which flushes nothing at all.
    onShutdown('flush against a dead database', () => new Promise<void>(() => { /* never */ }));

    const io = spyIo();
    void shutdown(0, io, 10_000);
    await Promise.resolve();
    expect(io.exits).toEqual([]);     // still trying

    await vi.advanceTimersByTimeAsync(10_000);

    expect(io.exits).toEqual([0]);
    expect(io.warnings.join('\n')).toContain('exceeded 10000ms');
  });

  it('does not fire once the steps have finished', async () => {
    onShutdown('quick', async () => { /* returns at once */ });

    const io = spyIo();
    await shutdown(0, io, 10_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // One exit, not two: the watchdog was cleared rather than left to fire into a dead process.
    expect(io.exits).toEqual([0]);
  });
});

describe('fatal', () => {
  it('exits 1 so a supervisor restarts the gateway', async () => {
    const io = spyIo();
    fatal('unhandledRejection', new Error('boom'), io);
    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('carries a stable FATAL token an alert can match on', async () => {
    const io = spyIo();
    fatal('uncaughtException', new Error('boom'), io);
    expect(io.warnings.join('\n')).toContain('FATAL');
    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('says which of the two kinds escaped', async () => {
    const io = spyIo();
    fatal('unhandledRejection', new Error('boom'), io);
    expect(io.warnings.join('\n')).toContain('unhandledRejection');
    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('keeps the stack, which for a programmer error is the whole report', async () => {
    const io = spyIo();
    const err = new Error('the actual cause');
    fatal('uncaughtException', err, io);
    expect(io.warnings.join('\n')).toContain('the actual cause');
    expect(io.warnings.join('\n')).toContain('lifecycle.test');   // i.e. a real stack, not just the message
    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('survives a rejection that is not an Error', async () => {
    // `Promise.reject('a string')` is legal and does happen; the handler must not itself throw.
    const io = spyIo();
    fatal('unhandledRejection', 'a bare string', io);
    expect(io.warnings.join('\n')).toContain('a bare string');
    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('still flushes on the way out', async () => {
    const flushed: string[] = [];
    onShutdown('flush', async () => { flushed.push('flushed'); });

    const io = spyIo();
    fatal('uncaughtException', new Error('boom'), io);
    await vi.waitFor(() => expect(io.exits).toEqual([1]));

    // The point of catching these at all: Node's default would have exited without this.
    expect(flushed).toEqual(['flushed']);
  });
});

describe('installCrashHandlers', () => {
  // Registering an `uncaughtException` listener REPLACES Node's default exit. These tests exist to
  // prove the replacement still ends the process — a handler that logged and returned would leave
  // a broken gateway serving traffic, which is worse than the crash it caught.
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  it('turns an escaped rejection into a graceful exit 1', async () => {
    const io = spyIo();
    installCrashHandlers(io);

    process.emit('unhandledRejection', new Error('escaped'), Promise.resolve());

    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });

  it('turns an uncaught exception into a graceful exit 1', async () => {
    const io = spyIo();
    installCrashHandlers(io);

    process.emit('uncaughtException', new Error('escaped'));

    await vi.waitFor(() => expect(io.exits).toEqual([1]));
  });
});
