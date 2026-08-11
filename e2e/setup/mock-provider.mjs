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

// A stand-in upstream provider: the smallest OpenAI-compatible server that lets the
// gateway complete a real round trip. Spawned as its own process so the gateway
// reaches it over an actual socket — the point of the suite is that nothing is
// in-process. Plain node:http, zero dependencies.
//
// It also keeps a ledger of every request it receives (`GET /__requests`), which is
// how a test proves a negative: a rate-limited request must show up as a rejection
// AND as an absence here — refused at the gateway, never billed upstream.

import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '3110', 10);

/** Every call the gateway has made to us, newest last. */
const ledger = [];

/**
 * The words this provider streams, one per SSE chunk. Exported knowledge: a spec asserts the
 * concatenation, so a gateway that delivers perfect event framing and no text fails.
 *
 * The emoji is not decoration. It is four bytes, and it is written across two socket writes so the
 * gateway receives an incomplete UTF-8 sequence at a chunk boundary — the ordinary case for any
 * real stream, and the one a per-chunk decoder silently turns into replacement characters.
 */
const STREAM_PIECES = ['The mock ', 'provider ', 'streams ', '👋', ' done'];

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const deltaChunk = (model, delta, finish = null) => sse({
  id: 'mock-stream-1',
  object:  'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An OpenAI-compatible SSE stream, written to the socket in pieces on purpose.
 *
 * Nagle is disabled and the writes are spaced, because a stream that arrives as one TCP segment
 * would exercise none of what this exists to exercise: the gateway would decode a single complete
 * buffer, and a decoder that forgets its tail between chunks would pass.
 */
async function streamCompletion(res, parsed) {
  const model = parsed?.model ?? 'mock-model-1';
  res.socket?.setNoDelay(true);
  res.writeHead(200, {
    'content-type':  'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection':    'keep-alive',
  });

  res.write(deltaChunk(model, { role: 'assistant', content: STREAM_PIECES[0] }));

  for (const piece of STREAM_PIECES.slice(1)) {
    await wait(15);
    const bytes = Buffer.from(deltaChunk(model, { content: piece }), 'utf8');
    // Split a multi-byte character down the middle when there is one, otherwise split the payload
    // anywhere — either way the gateway is handed a fragment it cannot decode on its own.
    const lead = bytes.findIndex((b) => b >= 0xf0);
    const cut  = lead > -1 ? lead + 2 : Math.floor(bytes.length / 2);
    res.write(bytes.subarray(0, cut));
    await wait(15);
    res.write(bytes.subarray(cut));
  }

  await wait(15);
  // Usage on the final chunk, as OpenAI sends it under `stream_options.include_usage`. The gateway
  // reads it from the stream rather than guessing, so the same fixed counts the non-streaming reply
  // reports are available here.
  res.write(sse({
    id: 'mock-stream-1', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
  }));
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.url === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count: ledger.length, requests: ledger }));
    }

    if (req.url === '/__reset' && req.method === 'POST') {
      ledger.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* recorded as null */ }

    ledger.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
      model: parsed?.model ?? null,
    });

    if (req.method === 'POST' && req.url === '/v1/chat/completions' && parsed?.stream === true) {
      // Spaced writes make this async; a rejection here would otherwise be silent and the socket
      // would hang until the gateway's idle guard fired, which reads as a gateway fault.
      streamCompletion(res, parsed).catch((err) => {
        console.error('mock provider stream failed:', err);
        res.destroy();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: `mock-${ledger.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed?.model ?? 'mock-model-1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'The mock provider answers.' },
          finish_reason: 'stop',
        }],
        // Fixed, known token counts so a test can predict exactly when a TPM budget runs out.
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }));
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model-1' }] }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `mock provider has no route for ${req.method} ${req.url}` }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider listening on 127.0.0.1:${PORT}`);
});
