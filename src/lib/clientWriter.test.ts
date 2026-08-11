/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Backpressure is invisible when it works and invisible when it does not, which is why it went
// unhandled: `reply.raw.write(value)` returns a value the old code never read, and ignoring it
// produces no error, no warning and no failing test — only a heap that grows once per slow caller.
//
// So every test here is about the waiting. Whether it happens, whether it ends, and whether it ends
// for the three reasons that are not the caller catching up — because a wait that can only end on
// `drain` is a leak wearing the costume of a fix.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createClientWriter, type BackpressureSink } from './clientWriter';

/** A sink that behaves like a socket: emits events, and reports when it is full. */
class FakeSocket extends EventEmitter implements BackpressureSink {
  written: string[] = [];
  full = false;
  write(chunk: string | Uint8Array): unknown {
    this.written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return !this.full;
  }
}

/** What every stand-in in this codebase looks like: a write method, and nothing else. */
const plainSink = () => {
  const written: string[] = [];
  return { written, write: (c: string | Uint8Array) => { written.push(String(c)); } };
};

/**
 * Has a promise settled? Answered without awaiting it.
 *
 * The losing side has to be a macrotask, not `Promise.resolve()`. A resolved promise wins the race
 * in the same microtask tick whatever it is racing, so the first version of this returned "still
 * pending" for everything — including the cases where the wait had already ended, which is the
 * bug it exists to detect.
 */
const settled = async (p: Promise<unknown>) => {
  const stillWaiting = new Promise((r) => setImmediate(() => r('pending')));
  return (await Promise.race([p.then(() => 'done'), stillWaiting])) === 'done';
};

describe('a caller who is keeping up', () => {
  it('is written to without waiting', async () => {
    const socket = new FakeSocket();
    const w = createClientWriter(socket, new AbortController().signal);

    await w.write('data: one\n\n');
    await w.write('data: two\n\n');

    expect(socket.written).toEqual(['data: one\n\n', 'data: two\n\n']);
    expect(w.gone()).toBe(false);
  });
});

describe('a caller who is not keeping up', () => {
  it('is not written past, until it drains', async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const w = createClientWriter(socket, new AbortController().signal);

    const pending = w.write('data: one\n\n');
    expect(await settled(pending), 'returned before the caller had room').toBe(false);

    socket.emit('drain');
    expect(await settled(pending)).toBe(true);
  });

  it('still delivered the chunk it is waiting on', async () => {
    // The wait is for the NEXT write, not this one — Node has already accepted this chunk into
    // memory. Dropping it would turn a pause into a hole in the answer.
    const socket = new FakeSocket();
    socket.full = true;
    const w = createClientWriter(socket, new AbortController().signal);

    const pending = w.write('data: one\n\n');
    socket.emit('drain');
    await pending;

    expect(socket.written).toEqual(['data: one\n\n']);
  });
});

describe('a caller who is never going to drain', () => {
  // Each of these is a way the wait could outlive the thing it is waiting for. A writer that hangs
  // on any of them holds the request, its memory and its token reservation until the process dies —
  // strictly worse than the unbounded buffering it replaced.

  it('stops waiting when the connection closes', async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const w = createClientWriter(socket, new AbortController().signal);

    const pending = w.write('x');
    socket.emit('close');

    expect(await settled(pending)).toBe(true);
    expect(w.gone()).toBe(true);
  });

  it('stops waiting when the connection errors', async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const w = createClientWriter(socket, new AbortController().signal);

    const pending = w.write('x');
    socket.emit('error');

    expect(await settled(pending)).toBe(true);
    expect(w.gone()).toBe(true);
  });

  it('stops waiting when the request is aborted', async () => {
    // The whole-request ceiling fires through this signal. It is the guard that bounds a caller who
    // accepts the connection and then never reads a byte — nothing else would ever fire.
    const socket = new FakeSocket();
    socket.full = true;
    const ac = new AbortController();
    const w = createClientWriter(socket, ac.signal);

    const pending = w.write('x');
    ac.abort();

    expect(await settled(pending)).toBe(true);
  });

  it('does not wait at all once the request is already aborted', async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const ac = new AbortController();
    ac.abort();

    expect(await settled(createClientWriter(socket, ac.signal).write('x'))).toBe(true);
  });
});

describe('a sink that is not a socket', () => {
  // The Playground's capturing reply, the Anthropic translator, every test harness. None of them
  // emit events and none of them are ever slow.

  it('is written to without waiting for an event it will never emit', async () => {
    const sink = plainSink();
    const w = createClientWriter(sink, new AbortController().signal);

    expect(await settled(w.write('a'))).toBe(true);
    expect(await settled(w.write('b'))).toBe(true);
    expect(sink.written).toHaveLength(2);
  });

  it('is never reported as gone', async () => {
    const w = createClientWriter(plainSink(), new AbortController().signal);
    await w.write('a');
    expect(w.gone()).toBe(false);
  });

  it('survives release, which has no listeners to drop', () => {
    expect(() => createClientWriter(plainSink(), new AbortController().signal).release()).not.toThrow();
  });

  it('reads a silent sink as silent, not as a refusal', async () => {
    // The distinction that makes the soft failure safe. A sink returning `undefined` has not said
    // stop; treating it as `false` would make every request in this test suite wait forever.
    const sink = { write: () => undefined };
    expect(await settled(createClientWriter(sink, new AbortController().signal).write('a'))).toBe(true);
  });

  it('does not wait on a sink that emits events but reports nothing', async () => {
    // The case that separates `!== false` from a truthiness check. On a sink with no events the two
    // behave identically, so a looser check would pass every test above — and then hang on the one
    // shape that has somewhere to wait and nothing to wait for.
    class SilentEmitter extends EventEmitter {
      write(): unknown { return undefined; }
    }
    const w = createClientWriter(new SilentEmitter(), new AbortController().signal);
    expect(await settled(w.write('a'))).toBe(true);
  });
});

describe('letting go', () => {
  it('drops its listeners, so a kept-alive socket does not accumulate them', () => {
    // One request's listeners left on a pooled socket is a slow leak that only shows up under the
    // load it is hardest to reproduce.
    const socket = new FakeSocket();
    const w = createClientWriter(socket, new AbortController().signal);
    expect(socket.listenerCount('close') + socket.listenerCount('error')).toBe(2);

    w.release();
    expect(socket.listenerCount('close') + socket.listenerCount('error')).toBe(0);
  });

  it('leaves no listener behind after a wait that ended', async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const w = createClientWriter(socket, new AbortController().signal);

    const pending = w.write('x');
    socket.emit('drain');
    await pending;
    w.release();

    expect(socket.listenerCount('drain')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
  });

  it('can be released more than once', () => {
    const w = createClientWriter(new FakeSocket(), new AbortController().signal);
    w.release();
    expect(() => w.release()).not.toThrow();
  });
});

describe('what it does not do', () => {
  it('does not swallow a throw from the sink', async () => {
    // A sink that throws is a bug worth seeing, not a slow caller to wait for. `write` is async, so
    // the throw surfaces as a rejection — which the proxy's own catch turns into a failed stream.
    const sink = { write: vi.fn(() => { throw new Error('socket destroyed'); }) };
    await expect(createClientWriter(sink, new AbortController().signal).write('x'))
      .rejects.toThrow('socket destroyed');
  });
});
