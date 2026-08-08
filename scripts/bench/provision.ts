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

// Claim the composed gateway, give it a pool, a key and a model, and print what the OTHER machine
// needs to drive load at it.
//
//   docker compose -f docker-compose.bench.yml up -d --build
//   npm run bench:provision
//
// Separate from the compose file because provisioning is a sequence of authenticated HTTP calls
// against a gateway that has to be running first, and separate from scripts/bench/k6.ts because in
// a two-machine rig the generator is not on this host and cannot be orchestrated from here.
//
// The gateway prints its API key exactly once, on first boot, and never again — so this reads it
// from the container log rather than asking for it. Re-running against an already-claimed gateway
// will fail at the claim step; bring the rig down with `-v` and up again for a clean one.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { API_KEY_FILE, provisionGateway, readContainerApiKey } from './gateway';

const COMPOSE_FILE = 'docker-compose.bench.yml';
const GATEWAY_HOST_PORT = 3401;
const MOCK_HOST_PORT = 3210;

/** Already git-ignored — see .gitignore, added alongside the profiling artifacts. */
const KEY_DIR = '.bench';
const KEY_FILE = join(KEY_DIR, 'api-key');

/**
 * This host's address on the local network.
 *
 * The generator is on another machine, so `localhost` is useless to it. Reported rather than left
 * for the reader to work out, because getting it wrong produces a connection refused that looks
 * exactly like the gateway being down.
 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Docker and WSL create their own interfaces with private addresses no other machine on the
      // network can reach. Naming them would send the reader down a dead end.
      if (/^(vEthernet|docker|br-|veth|WSL)/i.test(name)) continue;
      out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

/** Run a command inside a compose service and return its stdout. */
function composeExec(service: string, ...command: string[]): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', service, ...command], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Store the key where it can be copied, and print none of it.
 *
 * The obvious design prints the key inside the commands to paste. CodeQL calls that
 * `js/clear-text-logging` and is right to: printed output lands in scrollback, in CI logs and in
 * any terminal recording — and this is precisely the script somebody adapts to point at a gateway
 * that is not a benchmark rig. "It is only a mock upstream" is how real credentials reach logs.
 *
 * A masked prefix was the first attempt and CodeQL still flagged it, because `slice` does not
 * sanitise anything — the value is still derived from the secret. On reflection the analyser has
 * the better instinct: six characters of a key are no use to a reader who has the file, and the
 * habit of printing "just a bit" of a credential is not one worth keeping. Nothing derived from the
 * key reaches the console now; the path does, and the file holds the value.
 */
function storeKey(apiKey: string): void {
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(KEY_FILE, apiKey, { mode: 0o600 });
  // The mode argument is ignored on Windows, so it is applied explicitly where it means something.
  if (process.platform !== 'win32') chmodSync(KEY_FILE, 0o600);
}

async function main(): Promise<void> {
  const hostUrl = `http://127.0.0.1:${GATEWAY_HOST_PORT}`;

  const health = await fetch(`${hostUrl}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`The gateway is not answering on ${hostUrl}.`);
    console.error(`Bring the rig up first:  docker compose -f ${COMPOSE_FILE} up -d --build`);
    process.exit(1);
  }

  // From the container's filesystem rather than its logs — the gateway writes the key to a 0600
  // file so it never reaches stdout, and this reads it the same way an operator would.
  storeKey(readContainerApiKey(() => composeExec('gateway', 'cat', `/tmp/nexus-data/${API_KEY_FILE}`)));
  // `mock` is the service name on the compose network — the address the GATEWAY uses to reach its
  // upstream, which is not the address anything outside the rig uses.
  await provisionGateway(hostUrl, 'http://mock:3210');

  const addresses = lanAddresses();
  const primary = addresses[0]?.split(' ')[0] ?? '<this-host-ip>';
  const gw = `http://${primary}:${GATEWAY_HOST_PORT}/v1/chat/completions`;
  const mock = `http://${primary}:${MOCK_HOST_PORT}/v1/chat/completions`;

  const lines = [
    '',
    '  Gateway provisioned: one pool, one key, one model.',
    '',
    `  API key  → ${KEY_FILE}   (mode 0600, git-ignored)`,
    '             Not printed, not even in part. Read the file if you need to see it.',
    '',
    '  Reachable on this host at:',
    ...addresses.map((a) => `    http://${a.replace(/\s+\(/, `:${GATEWAY_HOST_PORT}  (`)}`),
    '',
    '  ── On the LOAD GENERATOR machine ──────────────────────────────────────────────',
    '',
    '  Copy the key across first, so it never passes through a terminal:',
    `    scp ${KEY_FILE} <user>@<generator>:/tmp/nexus-bench-key`,
    '',
    '  Measure the gateway:',
    '    API_KEY=$(cat /tmp/nexus-bench-key) RATE=400 DURATION=20s PRE_VUS=400 MAX_VUS=2000 \\',
    `      TARGET_URL=${gw} \\`,
    '      k6 run scripts/bench/k6/openLoop.js',
    '',
    '  And the rig\'s own ceiling — same network, gateway removed from the path. Run it at',
    '  EVERY rate you measure, not only the highest: a baseline taken at one rate cannot',
    '  attribute a tail at another, and the overhead IS the subtraction between the two.',
    '    API_KEY=$(cat /tmp/nexus-bench-key) RATE=400 DURATION=20s PRE_VUS=400 MAX_VUS=2000 \\',
    `      TARGET_URL=${mock} \\`,
    '      k6 run scripts/bench/k6/openLoop.js',
    '',
    '  Closed-loop comparison (set VUS instead of RATE) — how the coordinated-omission',
    '  claim gets checked rather than asserted:',
    '    API_KEY=$(cat /tmp/nexus-bench-key) VUS=64 DURATION=20s \\',
    `      TARGET_URL=${gw} \\`,
    '      k6 run scripts/bench/k6/openLoop.js',
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
