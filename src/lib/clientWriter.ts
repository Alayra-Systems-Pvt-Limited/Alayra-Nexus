/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Writing to a caller who may not be keeping up ─────────────────────────────────────────────
//
// `socket.write()` returns `false` when Node has accepted a chunk into memory rather than put it
// on the wire, which is its way of saying stop. The proxy ignored that return value, so a caller
// reading slowly — a phone on a train, a browser tab in the background, a script that forgot to
// consume the body — did not slow the gateway down. It made the gateway hold the rest of the
// answer on their behalf, at full speed, until the provider had finished sending it.
//
// The cost is per slow caller, and it is the whole remaining answer each time. Ten of them on a
// long answer is not ten slow requests, it is ten copies of an answer nobody is reading.
//
// Waiting for `drain` before reading the next chunk from the provider pushes back through the
// whole chain: this process stops reading, undici stops acknowledging, and the provider's socket
// fills up. The answer waits where it already is instead of being moved into this process's heap.
//
// ── Why the events are optional ───────────────────────────────────────────────────────────────
//
// The proxy writes to real sockets in production and to stand-ins everywhere else — the Playground's
// capturing reply, the Anthropic translator, the harnesses in the tests. None of those are event
// emitters, and none of them are ever slow. A stand-in reports `undefined` rather than `false`, and
// this waits for nothing.
//
// That is a deliberate soft failure, and the one thing that could hide a real bug here, so the
// distinction is `!== false` rather than truthiness: a sink that says nothing is not a sink that
// said stop.

export interface ClientWriter {
  /** Write a chunk, resolving once the caller has room for the next one. */
  write(chunk: string | Uint8Array): Promise<void>;
  /** True once the caller's connection has gone away and there is nothing left to write to. */
  gone(): boolean;
  /** Drop the listeners. Safe to call more than once. */
  release(): void;
}

/** The part of `reply.raw` this needs. Everything past `write` is present on a socket and absent
 *  on every stand-in, which is exactly the difference this module is built around. */
export interface BackpressureSink {
  write(chunk: string | Uint8Array): unknown;
  once?(event: string, listener: () => void): unknown;
  off?(event: string,  listener: () => void): unknown;
}

export function createClientWriter(raw: BackpressureSink, signal: AbortSignal): ClientWriter {
  const emits = typeof raw.once === 'function' && typeof raw.off === 'function';
  let departed = false;
  const depart = (): void => { departed = true; };

  if (emits) { raw.once!('close', depart); raw.once!('error', depart); }

  return {
    gone: () => departed,

    release() {
      if (emits) { raw.off!('close', depart); raw.off!('error', depart); }
    },

    async write(chunk) {
      // `false` is the only value that means "stop". `undefined` from a stand-in is not a refusal,
      // and treating it as one would make every test await a `drain` that will never be emitted.
      if (raw.write(chunk) !== false) return;
      if (!emits || departed || signal.aborted) return;

      await new Promise<void>((resolve) => {
        const settle = (): void => {
          raw.off!('drain', settle);
          raw.off!('close', settle);
          raw.off!('error', settle);
          signal.removeEventListener('abort', settle);
          resolve();
        };
        // Four ways to stop waiting, and only one of them is the caller catching up. A wait that
        // could only end on `drain` would outlive a caller who hung up, which is the failure this
        // is meant to prevent rather than reproduce.
        raw.once!('drain', settle);
        raw.once!('close', settle);
        raw.once!('error', settle);
        signal.addEventListener('abort', settle, { once: true });
      });
    },
  };
}
