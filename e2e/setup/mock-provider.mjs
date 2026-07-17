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
