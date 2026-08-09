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

// Telling "the key-value store is unreachable" apart from "this code has a bug".
//
// The distinction earns its own file because everything downstream depends on getting it right in
// BOTH directions, and the two mistakes are not symmetrical:
//
//   Too narrow — a real KV outage is reported as a 500. The caller is told the gateway is broken
//                when it is the gateway's dependency that is missing, gets no Retry-After, and has
//                no reason to try again.
//
//   Too wide   — a genuine bug is dressed up as a dependency outage. A 503 says "come back later"
//                about a defect that will still be there later, and the error is filed under
//                somebody else's incident. This is the worse of the two, so the predicate matches
//                on specific, observed failures and never on a general shape.
//
// Every string below was taken from a real ioredis rejection against a stopped Redis, not from the
// documentation.

/** ioredis names this one; the rest arrive as bare Errors distinguishable only by message. */
const NAMES = new Set([
  'MaxRetriesPerRequestError',
]);

/**
 * Messages ioredis produces when the store cannot be reached.
 *
 * Matched as prefixes on purpose. `Command timed out` carries no further detail today, but a
 * future ioredis is more likely to append to these than to rewrite them.
 */
const MESSAGE_PREFIXES = [
  'Command timed out',
  "Stream isn't writeable",
  'Connection is closed',
  'Reached the max retries per request limit',
];

/** Socket-level codes. These reach us when the failure is below ioredis rather than inside it. */
const CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * True when this error means "the key-value store did not answer".
 *
 * Deliberately NOT true for an error merely thrown by code that happens to touch Redis — a
 * `TypeError` from a bad argument is our bug and must keep its 500.
 */
export function isKvUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (NAMES.has(err.name)) return true;

  const code = (err as Error & { code?: unknown }).code;
  if (typeof code === 'string' && CODES.has(code)) return true;

  return MESSAGE_PREFIXES.some((prefix) => err.message.startsWith(prefix));
}

/**
 * What to put in `Retry-After` when refusing because the store is unreachable.
 *
 * Short, because the honest expectation is a quick recovery: a Redis restart or failover is
 * seconds, and the connection heals itself without anything being restarted. A long value would
 * park a well-behaved client for minutes after the outage had already ended.
 */
export const KV_RETRY_AFTER_SECONDS = 5;

/**
 * Fastify's error handler, with one exception carved out of it.
 *
 * Lives here rather than inline in `server.ts` so it can be driven by a test through a real
 * Fastify instance — the behaviour that matters is the status code and the header, and asserting
 * those against the predicate alone would prove nothing about what a caller receives.
 */
export function kvAwareErrorHandler(
  error: Error,
  request: { log: { error: (obj: unknown, msg: string) => void } },
  reply: {
    code: (n: number) => typeof reply;
    header: (k: string, v: string) => typeof reply;
    send: (body: unknown) => unknown;
  },
): unknown {
  if (isKvUnavailable(error)) {
    request.log.error({ err: error }, 'key-value store unavailable — refusing with 503');
    return reply
      .code(503)
      .header('Retry-After', String(KV_RETRY_AFTER_SECONDS))
      // Never cached: a 503 a proxy remembers outlives the outage it describes.
      .header('cache-control', 'no-store')
      .send({
        error: 'The gateway cannot reach its key-value store, so it cannot enforce rate limits '
             + `or budgets. Retry in ${KV_RETRY_AFTER_SECONDS}s.`,
      });
  }
  // Hand anything else back to Fastify, which logs it and serialises it exactly as before.
  return reply.send(error);
}
