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

// A stand-in provider built for LOAD, not for assertions.
//
// ── Why not reuse e2e/setup/mock-provider.mjs ─────────────────────────────────────────────────
//
// That one pushes every request it receives into an array, so a test can prove a negative ("this
// request was refused at the gateway and never reached upstream"). That is exactly right for a test
// and exactly wrong here: a benchmark sends hundreds of thousands of requests, and an array that
// grows with every one of them turns into allocation, then garbage collection, then a p99 that is
// measuring the mock's memory pressure rather than the gateway. The measuring instrument must not
// be the thing under load.
//
// So this keeps counters, never a list. Everything it can be asked to do is a number.
//
// ── What it can be told to be ─────────────────────────────────────────────────────────────────
//
// Real providers are not uniformly fast and healthy, and the interesting benchmarks are the ones
// where they are not. Behaviour is changed at RUNTIME through POST /__behaviour rather than by
// restarting with different flags, so one scenario can measure the gateway across a provider going
// slow, erroring and recovering — which is what failover actually has to survive.
//
//   POST /__behaviour {"latencyMs":0,"status":200,"failRate":0,"rate429":0}
//   GET  /__stats     → {requests, byStatus, inFlight}
//   POST /__reset     → zero the counters
//
//   node scripts/bench/mockUpstream.mjs            (PORT, default 3210)

import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '3210', 10);

/**
 * Current behaviour. Mutable on purpose — see the header.
 *
 * `latencyMs` is applied with setTimeout, whose granularity is about a millisecond and which is
 * therefore useless below that. Scenarios that need "as fast as possible" use 0, which skips the
 * timer entirely rather than scheduling a zero-delay one.
 */
const behaviour = {
  /** Delay before responding. 0 skips the timer. */
  latencyMs: 0,
  /** Status for a normal response. */
  status: 200,
  /** Fraction of requests answered 500, regardless of `status`. */
  failRate: 0,
  /** Fraction of requests answered 429, taking precedence over failRate. */
  rate429: 0,
};

/** Nothing may ask for a longer delay than this. See `sanitise`. */
const MAX_LATENCY_MS = 30_000;

/**
 * The only delays this server will ever wait for.
 *
 * A benchmark asks for "about 200 ms", never for 237. Quantising to a fixed ladder costs nothing
 * real and buys the one property clamping could not: the argument to setTimeout is always a literal
 * from this array, so no number originating in a request body reaches a timer at all — which is
 * what `js/resource-exhaustion` is actually about, and what two rounds of arithmetic bounds failed
 * to establish.
 */
const ALLOWED_DELAYS_MS = Object.freeze([1, 2, 5, 10, 25, 50, 100, 200, 500, 1_000, 5_000, 30_000]);

/** The closest allowed delay at or below `wanted`, and never above MAX_LATENCY_MS. */
function nearestAllowedDelay(wanted) {
  let chosen = ALLOWED_DELAYS_MS[0];
  for (const candidate of ALLOWED_DELAYS_MS) {
    if (candidate <= wanted) chosen = candidate;
  }
  return chosen;
}

/**
 * Clamp an incoming behaviour to values this server can actually honour.
 *
 * CodeQL flagged the unclamped version as `js/resource-exhaustion` (high): `latencyMs` arrives in a
 * POST body and went straight into setTimeout, so anything reaching this port could park every
 * request for as long as it liked.
 *
 * The exploit is theoretical — this binds to loopback, lives under scripts/, and is not in the
 * published package — but the alert is still correct, and the fix is worth having on its own terms:
 * a scenario that means to write `latencyMs: 200` and writes `200000` would otherwise hang a
 * benchmark for three minutes with no output and no explanation. Clamping turns that into a run
 * that is merely slow.
 *
 * Everything is clamped rather than rejected, and clamped ON ASSIGNMENT, so the stored behaviour is
 * always a set of values the rest of this file can use without re-checking. `status` is bounded to
 * the range writeHead accepts, because an out-of-range one throws inside the request handler and
 * takes the process down mid-run.
 */
function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  // Written as explicit comparisons rather than Math.min/Math.max. Both compute the same number,
  // but only this shape is a bound that CodeQL's taint tracking can follow: the Math.min version
  // was rejected a second time, on the very line that was supposed to be the fix. A guard a static
  // analyser cannot read is a guard a reviewer has to take on trust.
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function sanitise(input) {
  const out = {};
  if ('latencyMs' in input) out.latencyMs = clamp(input.latencyMs, 0, MAX_LATENCY_MS, 0);
  if ('status'    in input) out.status    = clamp(input.status, 100, 599, 200);
  if ('failRate'  in input) out.failRate  = clamp(input.failRate, 0, 1, 0);
  if ('rate429'   in input) out.rate429   = clamp(input.rate429, 0, 1, 0);
  return out;
}

const stats = { requests: 0, inFlight: 0, byStatus: Object.create(null) };

/**
 * Deterministic pseudo-randomness, seeded per process.
 *
 * Math.random() would make a failure-mode benchmark unreproducible: two runs with `failRate: 0.1`
 * would fail different requests, and the difference between them could not be attributed to a
 * change in the gateway. This is a plain LCG — not good randomness, but the same sequence every
 * time, which is the property that matters here.
 */
let seed = 0x2545f491;
const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const count = (status) => {
  stats.requests++;
  stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
};

/** The response body, built once. Identical bytes every time, so serialisation is not in the loop. */
const COMPLETION = JSON.stringify({
  id: 'bench',
  object: 'chat.completion',
  created: 0,
  model: 'bench-model-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  // Fixed and non-zero so cost maths downstream has something real to work with.
  usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
});

const MODELS = JSON.stringify({ data: [{ id: 'bench-model-1' }] });

function respond(res, status, body) {
  count(status);
  stats.inFlight--;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // The body is drained even when unused: leaving it unread stalls the socket and the connection is
  // never reusable, which quietly turns a keep-alive benchmark into a connect-per-request one.
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url ?? '';

    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    if (url === '/__behaviour' && req.method === 'POST') {
      try { Object.assign(behaviour, sanitise(JSON.parse(body || '{}'))); } catch { /* keep the current one */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(behaviour));
    }
    if (url === '/__reset' && req.method === 'POST') {
      stats.requests = 0; stats.byStatus = Object.create(null);
      seed = 0x2545f491;   // so a re-run repeats the same failures
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }

    stats.inFlight++;

    const send = () => {
      if (behaviour.rate429 > 0 && next() < behaviour.rate429) {
        return respond(res, 429, '{"error":{"message":"rate limited","type":"rate_limit_error"}}');
      }
      if (behaviour.failRate > 0 && next() < behaviour.failRate) {
        return respond(res, 500, '{"error":{"message":"upstream failure","type":"server_error"}}');
      }
      if (req.method === 'GET' && url === '/v1/models') return respond(res, 200, MODELS);
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        return respond(res, behaviour.status, COMPLETION);
      }
      return respond(res, 404, `{"error":"no route for ${req.method} ${url}"}`);
    };

    // Bounded by CONSTRUCTION at the point of use, not merely by arithmetic.
    //
    // `sanitise` already clamped this on the way in, and that was not enough: the value handed to
    // setTimeout is still, as far as dataflow is concerned, a number that came from a request body.
    // So the delay actually used is picked from a frozen list of constants — whatever arrives, the
    // argument to setTimeout is one of twelve literals. Millisecond-exact delays are not something
    // a benchmark needs; a bounded, reproducible one is.
    if (behaviour.latencyMs <= 0) send();
    else setTimeout(send, nearestAllowedDelay(behaviour.latencyMs));
  });
});

// Node closes an idle keep-alive socket after 5s by default. A scenario that pauses between phases
// would then pay a fresh TCP handshake on its next request and record it as latency the gateway
// caused. Raised well past any pause these benchmarks take.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bench mock upstream on 127.0.0.1:${PORT}`);
});
