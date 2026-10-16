/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Noticing that the caller has hung up ──────────────────────────────────────────────────────
//
// A caller who closes the connection mid-answer (an editor's Stop button, a script killed with
// Ctrl+C) stops reading, but the provider does not stop writing. It keeps generating, and billing,
// until the answer is finished or its socket is closed. The only way to stop paying for tokens
// nobody will read is to close that socket, and the only thing in this process that can close it
// is the AbortController the upstream call was made with.
//
// So this watches the caller's side and calls `onGone` the moment it goes away, which the proxy
// wires to that controller. Event-driven rather than checked between chunks: a provider that is
// still thinking sends nothing for seconds at a time, and a check that only runs when a chunk
// arrives would keep the upstream open for all of them.
//
// `close` alone is enough on a real response: Node emits it after an `error` too, and after a
// normal finish, which is why the proxy releases the watch before it ends the response itself.
// A caller who left before the watch started is caught by `destroyed`, because `close` has
// already fired and will not fire again.
//
// Stand-ins (the Anthropic translator, the Playground's capturing reply) forward `once`, `off` and
// `destroyed` to the real socket. One that has none of them is a sink that cannot report a
// departure, and is treated as a caller who never leaves, which is how every stand-in behaved before.

/** The part of `reply.raw` this needs. All of it is optional: a stand-in may have none. */
export interface DepartureSink {
  readonly destroyed?: boolean;
  once?(event: 'close', listener: () => void): unknown;
  off?(event: 'close', listener: () => void): unknown;
}

export interface Departure {
  /** True once the caller's connection has gone away. */
  gone(): boolean;
  /** Stop watching. Safe to call more than once; call it before ending the response yourself. */
  release(): void;
}

export function watchDeparture(raw: DepartureSink | undefined, onGone: () => void): Departure {
  let departed = false;
  let watching = false;
  const depart = (): void => {
    if (departed) return;
    departed = true;
    watching = false;
    onGone();
  };

  if (raw?.destroyed === true) {
    depart();
  } else if (raw && typeof raw.once === 'function' && typeof raw.off === 'function') {
    raw.once('close', depart);
    watching = true;
  }

  return {
    gone: () => departed,
    release() {
      if (!watching) return;
      watching = false;
      raw!.off!('close', depart);
    },
  };
}
