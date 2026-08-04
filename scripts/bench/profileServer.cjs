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

// The compiled gateway, wrapped in a V8 sampling profiler that can be switched on and off from
// outside while it runs.
//
// ── Why not just `node --cpu-prof dist/server.js` ─────────────────────────────────────────────
//
// Two reasons, and the second one is fatal.
//
// 1. `--cpu-prof` profiles the WHOLE process lifetime. Boot, migrations, seeding, key generation
//    and warmup would all land in the same profile as the steady state we actually want to read,
//    and boot is expensive enough to dominate it. What we need is a profile of the measurement
//    window only, which means starting and stopping the profiler at chosen moments.
//
// 2. `--cpu-prof` writes its file when the process exits CLEANLY. The harness tears children down
//    with SIGKILL, and on Windows even `kill('SIGTERM')` is TerminateProcess — abrupt, no
//    handlers, no flush. So the profile would frequently not exist at all, and would go missing
//    exactly when a run was interrupted, which is when it is most wanted.
//
// Driving `inspector` in-process instead solves both: the window is chosen by the caller, and the
// file is written at Profiler.stop, long before anything kills anything.
//
//   POST /start  → begin sampling      (PROFILE_CONTROL_PORT, default 3402)
//   POST /stop   → write PROFILE_OUT and report the sample count
//   GET  /health → readiness for the harness's usual wait loop

const inspector = require('node:inspector');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CONTROL_PORT = parseInt(process.env.PROFILE_CONTROL_PORT ?? '3402', 10);
const OUT = process.env.PROFILE_OUT ?? path.join(process.cwd(), 'nexus.cpuprofile');

// V8's default is 1000µs. At roughly 3ms of CPU per request that is about three samples per
// request — enough to see a total, far too few to trust the shape within it. 100µs gives ten times
// the resolution; the sampler's own cost rises, but it falls on every frame equally, so the
// RANKING (which is what a profile is read for) is unaffected.
const SAMPLING_INTERVAL_US = parseInt(process.env.PROFILE_INTERVAL_US ?? '100', 10);

const session = new inspector.Session();
session.connect();

const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
});

let running = false;

const control = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.url === '/health') return reply(200, { ok: true, running });

  if (req.url === '/start' && req.method === 'POST') {
    if (running) return reply(200, { ok: true, already: true });
    // setSamplingInterval only takes effect while the profiler is stopped, so it goes first.
    post('Profiler.enable')
      .then(() => post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US }))
      .then(() => post('Profiler.start'))
      .then(() => { running = true; reply(200, { ok: true, intervalUs: SAMPLING_INTERVAL_US }); })
      .catch((e) => reply(500, { error: String(e) }));
    return;
  }

  if (req.url === '/stop' && req.method === 'POST') {
    if (!running) return reply(409, { error: 'profiler is not running' });
    post('Profiler.stop')
      .then(({ profile }) => {
        running = false;
        fs.writeFileSync(OUT, JSON.stringify(profile));
        reply(200, {
          ok: true,
          out: OUT,
          nodes: profile.nodes.length,
          samples: profile.samples.length,
          durationMs: (profile.endTime - profile.startTime) / 1000,
        });
      })
      .catch((e) => reply(500, { error: String(e) }));
    return;
  }

  return reply(404, { error: `no route for ${req.method} ${req.url}` });
});

control.listen(CONTROL_PORT, '127.0.0.1', () => {
  // Only now start the gateway. It logs the generated API key to stdout on first boot and the
  // harness scrapes it from there, so this must not run before the pipe is being read — and
  // requiring it in-process (rather than spawning it) is the whole point: the profiler session
  // above is attached to THIS isolate, so it has to be the isolate the gateway runs in.
  require(path.join(__dirname, '..', '..', 'dist', 'server.js'));
});
