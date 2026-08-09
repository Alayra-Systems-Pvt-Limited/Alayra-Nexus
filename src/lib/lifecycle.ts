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

// How this process ends — deliberately, on a signal, or because something escaped.
//
// ── The doctrine ──────────────────────────────────────────────────────────────────────────────
//
// Crash-only. There are two kinds of failure and they get opposite treatment:
//
//   Operational — the world is broken. Redis is down, a provider is returning 500, the disk is
//                 full. These must NEVER end the process. They are handled where they happen:
//                 degrade, circuit-break, answer 503 with a Retry-After. A gateway that exits
//                 because its cache is unreachable has turned someone else's outage into its own.
//
//   Programmer  — WE are broken. A null dereference, a violated invariant, a promise nobody
//                 caught. The state of the process is now unknown, and code that continues on
//                 unknown state is how a cost-control gateway starts double-charging. These end
//                 the process, immediately and on purpose.
//
// The failure this module exists for was the second kind wearing the first kind's clothes: a Redis
// outage reached the process as an unhandled rejection, because one background promise had no
// `.catch`. Node's default for that is to terminate — correctly, given it cannot know what the
// promise was doing. What it cannot do is flush the audit buffer on the way out, say what happened
// in a form an operator can alert on, or exit with a code that tells a supervisor to restart.
//
// ── Why this is a graceful CRASH and not a rescue ─────────────────────────────────────────────
//
// The tempting version of this file logs the error and carries on. That is worse than the bug it
// replaces. A process that survives an unhandled rejection is a process whose state nobody has
// checked, still holding the port, still passing liveness, still being sent traffic. The crash is
// not the problem — the crash is the immune response. This only makes it land well.
//
// ── Exit codes are load-bearing ───────────────────────────────────────────────────────────────
//
// `systemd Restart=on-failure` and `docker --restart=on-failure` both read the exit code, and both
// treat 0 as "it meant to stop, leave it alone". Exiting 0 after a crash is therefore not a cosmetic
// slip: it is the difference between a restart and an outage that lasts until someone notices.
// Signals exit 0. Crashes exit 1. Nothing else may decide this.

/** A wind-down step. Registered in the order it should run; each failure is contained. */
interface Step {
  name: string;
  run: () => Promise<unknown>;
}

const steps: Step[] = [];
let shuttingDown = false;

/**
 * How long the whole wind-down may take before the process leaves anyway.
 *
 * Every step here talks to something that can itself be down — Postgres for the audit flush,
 * the socket for in-flight requests. A drain with no deadline against a dead dependency does not
 * fail, it waits, and the orchestrator's own grace period ends in SIGKILL: no flush at all, which
 * is the outcome the drain existed to prevent. Ten seconds is comfortably inside Kubernetes'
 * default 30s `terminationGracePeriodSeconds`, so the deliberate exit always wins the race.
 */
export const SHUTDOWN_DEADLINE_MS = parseInt(process.env.NEXUS_SHUTDOWN_DEADLINE_MS ?? '10000', 10);

/** The side effects, injectable so tests can observe an exit instead of suffering one. */
export interface ShutdownIo {
  exit: (code: number) => void;
  warn: (message: string) => void;
}

const processIo: ShutdownIo = {
  exit: (code) => process.exit(code),
  warn: (message) => console.error(message),
};

/**
 * Add a step to the wind-down, to run in registration order.
 *
 * Order is the caller's business and it matters: close the listener before flushing the buffers
 * that in-flight requests are still writing into, and disconnect the database after both.
 */
export function onShutdown(name: string, run: () => Promise<unknown>): void {
  steps.push({ name, run });
}

/** Test seam. Forgets every registered step and re-arms the guard. */
export function resetLifecycle(): void {
  steps.length = 0;
  shuttingDown = false;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/**
 * Run every step, then leave with `code`.
 *
 * Re-entrant by design, but not idempotently: a SECOND call while the first is still running is
 * read as an operator who has stopped waiting, and exits at once. Ignoring it would mean a second
 * Ctrl-C does nothing, which trains people to reach for `kill -9` — and that skips the flush
 * entirely.
 */
export async function shutdown(
  code: number,
  io: ShutdownIo = processIo,
  deadlineMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  if (shuttingDown) {
    io.warn('  second signal — exiting now, without finishing the flush');
    io.exit(code);
    return;
  }
  shuttingDown = true;

  // Armed before the first step, and deliberately NOT unref'd. An unref'd timer would let Node
  // decide the event loop is empty and exit on its own — with code 0, silently, which is exactly
  // the wrong answer for a crash. This timer is the thing keeping the process alive long enough
  // to mean what it says.
  const watchdog = setTimeout(() => {
    io.warn(`  shutdown exceeded ${deadlineMs}ms — leaving with work unfinished`);
    io.exit(code);
  }, deadlineMs);

  for (const step of steps) {
    // Contained one by one. A failing flush must not cost the steps behind it: the database
    // disconnect still has to happen when the audit write is what failed.
    try {
      await step.run();
    } catch (err) {
      io.warn(`  shutdown step "${step.name}" failed — ${describe(err)}`);
    }
  }

  clearTimeout(watchdog);
  io.exit(code);
}

/** What escaped. Kept in the log line so an alert can distinguish the two without parsing a stack. */
export type FatalKind = 'unhandledRejection' | 'uncaughtException';

/**
 * Something escaped. Say so unmissably, then wind down and exit non-zero.
 *
 * The line carries a stable `FATAL` token on purpose: it is the string an operator's log alert
 * matches on, and it must not drift with a reword. The stack follows because for a programmer
 * error the stack IS the report — this is the one place in the codebase where a stack trace is
 * the signal rather than the noise.
 */
export function fatal(kind: FatalKind, err: unknown, io: ShutdownIo = processIo): void {
  io.warn(
    `\n✗ FATAL (${kind}) — Alayra Nexus is shutting down because an error reached the top of the\n` +
    '  process. This is a bug, not a configuration problem. The gateway will exit 1 so a\n' +
    `  supervisor restarts it.\n\n  ${describe(err)}\n`,
  );
  void shutdown(1, io);
}

/**
 * Catch what would otherwise end the process abruptly.
 *
 * Note what registering an `uncaughtException` listener does: it REPLACES Node's default, which
 * was to print and exit. So this handler is now solely responsible for ending the process, and a
 * version of it that forgot to exit would be strictly worse than no handler at all — it would
 * leave a broken process serving traffic. That is why `fatal` always ends in `shutdown(1)`, and
 * why the watchdog inside it is not optional.
 */
export function installCrashHandlers(io: ShutdownIo = processIo): void {
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason, io));
  process.on('uncaughtException',  (err)    => fatal('uncaughtException',  err,    io));
}
