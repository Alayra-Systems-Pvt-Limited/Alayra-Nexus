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

// ── What the gateway decided, and why ─────────────────────────────────────────────────────────
//
// The proxy path already knows all of this — which pool, which key, which model, whether the cache
// answered, what the guardrails did, what it cost. It knows it in local variables that go out of
// scope when the response is sent. Some of it reaches the caller as `X-Nexus-*` headers, some
// reaches the database as a `TokenUsage` row, and the rest is simply forgotten.
//
// This is the seam that collects it. An optional parameter on `handleProxy`: pass one and it is
// filled in as the request proceeds, pass nothing and the request path is unchanged. Every
// existing caller passes nothing.
//
// Built for the Playground (#104), whose entire claim is "this is the real router, and here is
// what it actually did". It is also what a routing question in Logs will eventually be answered
// with — "why did this go to that pool" is unanswerable today.
//
// ── The rule this file exists to enforce ──────────────────────────────────────────────────────
//
// EVERY FIELD IS WRITTEN BY THE CODE THAT ALREADY COMPUTED IT. Nothing here is derived, inferred
// or recomputed.
//
// The temptation is real: the cost is a pure function of the model and the token counts, so a
// trace could work it out for itself. Then there would be two cost calculations — the one written
// to `TokenUsage` and the one shown on screen — and they would agree right up until one of them
// changed. A number that disagrees with the invoice is worse than no number, because it is
// believed. So `recordTokenUsage` stamps the figure it actually recorded, and this reports that.
//
// ── And the one that keeps a credential out of it ─────────────────────────────────────────────
//
// `NexusRoute` carries `decryptedKey` — the live provider credential in plain text (see #117).
// Routing metadata is serialised into an admin API response for the first time because of this
// file, so the shape below has no field that could hold it and `keyMask` gives the legitimate
// "which key served this?" question a safe answer. `requestTrace.test.ts` asserts the plaintext
// cannot appear in a serialised trace.

/** Why the response cache did not serve this request — or that it did. */
export type CacheState =
  | 'hit'            // replayed from the cache; the provider was never called
  | 'miss'           // eligible, not present; the response will populate it
  | 'disabled'       // the operator has the cache switched off
  | 'not-cacheable'  // this request can never be cached (streaming tools, non-deterministic params)
  | 'bypassed';      // the caller asked to skip it — the Playground does, so a run proves the key

/** The route that served the request. Deliberately has nowhere to put a credential. */
export interface TraceRoute {
  /** The pool's provider slug — `anthropic`, `groq`, … */
  provider:    string;
  modelString: string;
  /** The registry model id, when selection came from the registry rather than the legacy path. */
  modelId:     string | null;
  tier:        string;
  keyId:       string;
  /** The masked form, never the key. See the note above and #117. */
  keyMask:     string;
  /** Chosen by cache-aware sticky routing rather than least-recently-used. */
  sticky:      boolean;
  /** The key is privately owned by the calling team rather than drawn from the shared pool. */
  byok:        boolean;
  /** Routing fell to a lower tier than the one asked for. */
  downgraded:  boolean;
  /** This request is the single half-open probe for a key the breaker is recovering. */
  probe:       boolean;
}

export interface TraceGuardrails {
  active:        boolean;
  input:         'pass' | 'redact' | 'block';
  inputMatched:  string[];
  /**
   * `skipped-streaming` is not a failure — it is the honest name for what happens when output
   * rules exist and the operator has not opted into buffering. Filtering a stream means collecting
   * it first, which costs the whole time-to-first-token win, so it is never done silently.
   */
  output:        'off' | 'applied' | 'buffered' | 'skipped-streaming';
  outputMatched: string[];
}

export interface TraceBudget {
  /** False when the caller has no team, or the team has no cap — there was nothing to check. */
  checked:    boolean;
  allowed:    boolean;
  /** What the team does at its cap: `block` | `notify` | `downgrade`. */
  action:     string;
  /** Admitted, but pinned to the cheapest tier because the cap was already crossed. */
  downgraded: boolean;
  spendUsd?:  number;
  budgetUsd?: number | null;
}

export interface TraceUsage {
  inputTokens:  number;
  outputTokens: number;
  /**
   * What was recorded, stamped by `recordTokenUsage` — never computed here.
   *
   * `null` means nothing has been recorded yet. Zero with `priced: false` means the model has no
   * price in the registry, which is NOT the same as free, and a panel that shows `$0.0000` for
   * both is lying about one of them.
   */
  estimatedUsd: number | null;
  /** What the cache saved: the price this request WOULD have cost, on a hit. */
  savedUsd:     number | null;
  /**
   * False when the model carries no price, so `$0` can be told apart from "nobody knows".
   *
   * Optional because it is only knowable once the registry has been consulted, which happens
   * inside `recordTokenUsage`. Absent means the question has not been asked yet — distinct from
   * `false`, which is the answer "this model has no price". A reader that treats the two the same
   * will report an unpriced model every time the recording has not landed.
   */
  priced?:      boolean;
}

export interface TraceTiming {
  /** Gateway → provider, to response headers. Absent when the provider was never called. */
  ttfbMs?:     number;
  /** Gateway → provider, to the last byte. */
  upstreamMs?: number;
  /** The whole request, including routing, guardrails and the cache lookup. */
  totalMs?:    number;
}

/**
 * Everything the gateway decided about one request.
 *
 * Mutable and filled in place, rather than returned. `handleProxy` has fifteen exits, and a
 * returned value would have to be threaded through every one of them — where a shared object is
 * filled by whichever exits are reached. A partially-filled trace is the correct record of a
 * request that was refused early, and reads as one.
 */
export interface RequestTrace {
  /** What the caller asked for: the raw `model` field, before resolution. */
  requestedModel: string | null;
  resolution:     'auto' | 'pinned' | 'unknown';
  stream:         boolean;
  scope?:         { namespace: string; byok: boolean; isolated: boolean };
  route?:         TraceRoute;
  cache:          CacheState;
  /**
   * On a cache hit, what produced the stored entry.
   *
   * Separate from `route` on purpose. A hit skips pool discovery entirely — there is no key, no
   * tier and no routing decision — so filling `route` would describe a request that never
   * happened. This says only what is true: the cache answered, and this is what wrote the entry.
   */
  cachedFrom?:    { provider: string; modelString: string };
  guardrails?:    TraceGuardrails;
  budget?:        TraceBudget;
  usage?:         TraceUsage;
  timing:         TraceTiming;
  /** The outcome the metrics recorded — `success`, `blocked`, `no_capacity`, `upstream_error`, … */
  outcome?:       string;
  /** Set when the gateway refused: the status it answered with, and which gate refused it. */
  refusal?:       { status: number; reason: string };
}

/**
 * An empty trace, for a caller to hand to `handleProxy`.
 *
 * The three fields with no sensible absent state are set here rather than left undefined: a
 * request either streams or it does not, and `cache: 'disabled'` is the correct reading before the
 * cache has been consulted — nothing has been served from it.
 */
export function newTrace(): RequestTrace {
  return {
    requestedModel: null,
    resolution:     'auto',
    stream:         false,
    cache:          'disabled',
    timing:         {},
  };
}
