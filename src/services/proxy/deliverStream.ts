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

// Imported through nexus.service so tests that mock './nexus.service' still intercept it.
import { reportServerFailure } from '../nexus.service';
import { countMessageTokens, countTokens } from '../../lib/tokenizer';
import { reconcileTpm } from '../../lib/admission';
import { createStreamTally } from '../../lib/streamTally';
import { createClientWriter } from '../../lib/clientWriter';
import * as metrics from '../../lib/metrics';
import { STREAM_IDLE_MS, STREAM_MAX_MS } from './config';
import { markHealthy, type Delivery } from './deliver';
import { storeStreamInCache } from './responseHelpers';
import { observe, recordUsage, routeUsage, stampUsage } from './run';
import { cutFrame, openEventStream, type CutReason } from './sse';

// ── Live streaming: relay the provider's stream at the caller's pace ──────────

export async function deliverStream(d: Delivery, body: ReadableStream<Uint8Array>): Promise<void> {
  const { run, dispatched, guarded, cache, nexusHeaders } = d;
  const { reply } = run;
  const { route, controller, departure, reserve, traceAttempt, sessionId } = dispatched;
  openEventStream(reply, nexusHeaders);

  const reader = body.getReader();
  // Reads the stream as it goes rather than holding it: the answer and the usage, not the wire.
  const tally  = createStreamTally();
  // Writes at the caller's pace rather than the provider's, so a slow reader slows the request
  // down instead of making this process hold the rest of their answer.
  const client = createClientWriter(reply.raw, controller.signal);
  let streamFailed = false;
  /** Set by whichever guard fires first; read once in `finally` to say what happened. */
  let cutShort: CutReason | null = null;

  const startIdleTimer = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => { cutShort ??= 'idle'; controller.abort(); }, STREAM_IDLE_MS);

  let idleTimer = startIdleTimer();
  const wholeTimer = setTimeout(() => { cutShort ??= 'duration'; controller.abort(); }, STREAM_MAX_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Stopped for the whole of the write, not restarted around it: this timer measures how long
      // the provider has been silent, and time spent waiting for a slow caller is not that. The
      // whole-request ceiling is what bounds a caller who never drains.
      clearTimeout(idleTimer);
      tally.push(value);
      await client.write(value);
      if (client.gone() || departure.gone()) { cutShort ??= 'client'; break; }
      idleTimer = startIdleTimer();
    }
  } catch { streamFailed = true; /* aborted (a guard fired, or the caller left) or upstream error mid-stream — keep what arrived */ }
  finally {
    clearTimeout(idleTimer);
    clearTimeout(wholeTimer);
    client.release();
    departure.release();
    // The departure watch aborted the read, so the loop never saw it: say so here.
    if (departure.gone()) cutShort ??= 'client';
    // Close the provider's socket, so it stops generating (and billing) an answer nobody will read.
    // Already done when the watch fired; this covers the loop's own break.
    if (cutShort === 'client') controller.abort();
    // Before reading the tally either way: a stream that died mid-flight still delivered tokens
    // the provider will bill for, and the last of them may be sitting in the decoder.
    tally.end();
    // Nothing to explain to a caller who has already hung up.
    if (cutShort && cutShort !== 'client') reply.raw.write(cutFrame(cutShort));
    reply.raw.end();
  }

  // Three endings. A caller who hung up cancelled it: not a provider fault, not a success. A stream
  // that connected (200 headers) but hung/aborted mid-flight is a server-side fault. A clean
  // completion closes the breaker and sticks, as does a cancel, since the provider was answering.
  // Every one delivered tokens the provider will bill for, so recordTokenUsage below writes the one
  // row and carries the real outcome — hence persist: false here (see observe in run.ts).
  const cancelled = cutShort === 'client';
  const outcome   = cancelled ? 'client_cancelled' : streamFailed ? 'upstream_error' : 'success';
  if (cancelled) { markHealthy(dispatched); observe(run, outcome, false); }
  else if (streamFailed) { void reportServerFailure(route.keyId, route.isProbe).catch(() => {}); metrics.providerError(route.providerSlug, 'server'); observe(run, outcome, false); }
  else { markHealthy(dispatched); observe(run, outcome); }
  if (traceAttempt) traceAttempt.outcome = cancelled ? 'client_cancelled' : streamFailed ? 'stream_error' : 'success';

  const usage        = tally.usage();
  const answer       = tally.content();
  const inputTokens  = usage?.input  ?? countMessageTokens(guarded.effectiveMessages);
  // Providers that report their own usage are believed. The rest are counted from what they
  // actually said — never below 1, since a request that reached a provider was not free.
  const outputTokens = usage?.output ?? Math.max(1, countTokens(answer));
  stampUsage(run, inputTokens, outputTokens);
  metrics.addTokens(inputTokens, outputTokens);
  // Only cache a cleanly-completed stream, and only one that was read whole: a dropped frame (or a
  // caller who left halfway) leaves a hole in the answer, and a cached hole is served to everyone.
  if (outcome === 'success' && !tally.degraded()) storeStreamInCache(cache.cacheStoreKey, answer, route.modelString, route.providerSlug, inputTokens, outputTokens, cache.cacheCfg.ttlSeconds);
  void reconcileTpm(route.keyId, reserve, inputTokens + outputTokens).catch(() => {});
  await recordUsage(run, { ...routeUsage(run, route, sessionId, inputTokens, outputTokens), outcome });
}
