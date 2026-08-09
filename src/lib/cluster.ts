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

// How many processes the gateway runs as.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
//
// A benchmark established that one gateway process costs about 1.5 ms of CPU per request and tops
// out near 670 requests a second — and that throughput barely improves from 8 concurrent callers to
// 32, because by then the single JavaScript thread is already 97% busy. That ceiling is not a bug
// to be optimised away. It is one core, and no amount of concurrency adds a second one.
//
// Node's answer is more processes sharing one listening socket, which is what this configures.
//
// ── The correctness problem that comes with it ────────────────────────────────────────────────
//
// Running N processes is only safe when the state they must agree about is OUTSIDE them. In
// standalone mode it is not: `lib/redis.ts` falls back to an in-process map when REDIS_URL is
// unset, and four processes then hold four independent copies of:
//
//   RPM / TPM admission   the serious one — each process would admit up to the full per-key limit,
//                         so a key capped at 60 requests a minute would serve up to 240
//   circuit breaker       four independent views of a provider's health; slower to open, and a
//                         key already cooling elsewhere still gets traffic here
//   sticky routing        a session pinned on one process is unknown to the other three, so its
//                         provider-side prompt cache is lost on three of every four requests
//   response cache        hit rate divided by the number of processes
//
// Only the first is a correctness failure rather than a performance one, and it is enough on its
// own. Silently multiplying an operator's rate limits by their core count is the kind of bug that
// surfaces as a provider suspension, so this refuses to start instead.
//
// The same reasoning already appears in server.ts, where @fastify/rate-limit is given the KV only
// when it is a real Redis: "running more than one replica in that mode is precisely what standalone
// mode says not to do."

import { cpus } from 'node:os';

/** Raised when the configuration asks for more processes than it can keep honest. */
export class ClusterUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterUnsafeError';
  }
}

/**
 * How many workers were asked for.
 *
 * Unset or `1` means the single-process gateway, unchanged. `auto` means one per core. Anything
 * unparseable means 1 — a typo must not silently start a cluster.
 */
export function desiredWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEXUS_CLUSTER_WORKERS?.trim().toLowerCase();
  if (!raw || raw === '1') return 1;
  if (raw === 'auto') return Math.max(1, cpus().length);

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  // A worker per core is the useful maximum; beyond that they only take turns on the same cores
  // while each holding its own connection pool. Capped rather than rejected so `NEXUS_CLUSTER_
  // WORKERS=64` on a small box degrades to something sensible instead of refusing to boot.
  return Math.min(n, Math.max(1, cpus().length * 2));
}

/**
 * Refuse to fork when the processes could not agree about rate limits.
 *
 * Deliberately fatal rather than a warning. A warning at boot is read once, by whoever set the
 * variable, and never again by whoever is on call when a provider suspends the account.
 */
export function assertClusterSafe(workers: number, opts: { usingMemoryKv: boolean; dbEngine: string }): void {
  if (workers <= 1) return;

  if (opts.usingMemoryKv) {
    throw new ClusterUnsafeError(
      `NEXUS_CLUSTER_WORKERS=${workers} needs a shared Redis, and REDIS_URL is not set.\n\n` +
      '  Without one, each worker keeps its own rate-limit counters, circuit-breaker state and\n' +
      '  sticky-session map. The per-key RPM and TPM limits would then be enforced once PER WORKER,\n' +
      `  so a key limited to 60 requests a minute could serve up to ${60 * workers} — which is the\n` +
      '  kind of mistake a provider answers with a suspension.\n\n' +
      '  Either set REDIS_URL, or leave NEXUS_CLUSTER_WORKERS unset to run the single-process\n' +
      '  gateway, which is the supported way to run standalone.',
    );
  }
}

// ── Replacing a worker that died ──────────────────────────────────────────────────────────────
//
// Supervision is the whole reason to run a cluster: a worker dies, another takes its place, and the
// gateway keeps serving. That is right for the failure it was written for — ONE worker hitting a bug
// on one request.
//
// It is wrong for the failure that actually happens in production, which is every worker dying for
// the same reason at the same time. A worker checks its dependencies at boot, so while Redis is
// unreachable each replacement dies during startup and is replaced immediately. Forking with no
// delay turns that into a spin: fork, fail, fork, fail, as fast as the machine allows, burning a
// core per worker and filling the log at the exact moment an operator is trying to read it. The
// outage lasts as long as it lasts; the fork loop is damage we add on top of it.
//
// So a replacement is instant the first time — the one-bad-request case keeps its fast recovery —
// and backs off from there. The window matters as much as the curve: crashes are counted only over
// the last minute, so a gateway that drops one worker an hour is never penalised for it, while one
// failing continuously slows to a probe every thirty seconds.
//
// It never gives up. A cap that stopped forking would make a recoverable dependency outage
// permanent, needing a human to restart something that would otherwise have healed itself.

/** First replacement is immediate; each further crash inside the window doubles from here. */
export const FORK_BACKOFF_BASE_MS = 200;
/** Ceiling. Long enough to stop the spin, short enough that recovery is not left waiting. */
export const FORK_BACKOFF_MAX_MS = 30_000;
/** Crashes older than this stop counting, so isolated deaths never accumulate into a penalty. */
export const CRASH_WINDOW_MS = 60_000;

/**
 * How long to wait before replacing a worker, given how many have died in the current window.
 *
 * `crashesInWindow` counts the crash being handled, so the first is 1 and returns no delay.
 */
export function forkDelayMs(crashesInWindow: number): number {
  if (crashesInWindow <= 1) return 0;
  const doublings = crashesInWindow - 2;
  // 2 ** 31 and beyond overflows into Infinity territory long before it matters, but Math.min
  // handles that too — the cap is what the caller actually sees.
  return Math.min(FORK_BACKOFF_BASE_MS * 2 ** doublings, FORK_BACKOFF_MAX_MS);
}

/**
 * Keeps the crash timestamps that `forkDelayMs` needs, discarding those that have aged out.
 *
 * A tiny amount of state, but it belongs next to the curve it feeds rather than loose in the
 * server's bootstrap — and out here it can be tested without forking anything.
 */
export function createCrashWindow(windowMs: number = CRASH_WINDOW_MS) {
  let recent: number[] = [];
  return {
    /** Record a crash at `now` and return how many are inside the window, including this one. */
    record(now: number): number {
      recent = recent.filter((at) => now - at < windowMs);
      recent.push(now);
      return recent.length;
    },
  };
}

/**
 * Whether this process should run the once-per-deployment background jobs.
 *
 * Retention, the health sampler and the backup scheduler are not per-request work and must not run
 * N times over. The first worker takes them; the others serve traffic only. (The backup scheduler
 * holds a Redis lock of its own, so this is belt and braces for that one — but retention and the
 * sampler have no such lock.)
 */
export function ownsBackgroundJobs(workerId: number | undefined): boolean {
  return workerId === undefined || workerId === 1;
}
