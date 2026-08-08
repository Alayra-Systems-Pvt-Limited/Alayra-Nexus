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
import { networkInterfaces } from 'node:os';
import { provisionGateway, readGeneratedApiKey } from './gateway';

const COMPOSE_FILE = 'docker-compose.bench.yml';
const GATEWAY_HOST_PORT = 3401;

/**
 * This host's address on the local network.
 *
 * The generator is on another machine, so `localhost` is useless to it. Reported rather than
 * guessed at by the reader, because getting this wrong produces a connection refused that looks
 * like the gateway is down.
 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Docker and WSL create their own interfaces with private addresses that no other machine on
      // the network can reach. Naming them would send the reader down a dead end.
      if (/^(vEthernet|docker|br-|veth|WSL)/i.test(name)) continue;
      out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

function composeLogs(service: string): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'logs', '--no-log-prefix', service], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

async function main(): Promise<void> {
  const hostUrl = `http://127.0.0.1:${GATEWAY_HOST_PORT}`;

  const health = await fetch(`${hostUrl}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`The gateway is not answering on ${hostUrl}.`);
    console.error(`Bring the rig up first:  docker compose -f ${COMPOSE_FILE} up -d --build`);
    process.exit(1);
  }

  const apiKey = readGeneratedApiKey(composeLogs('gateway'));
  // `mock` is the service name on the compose network — the address the GATEWAY uses, which is not
  // the address anything outside the rig uses.
  await provisionGateway(hostUrl, 'http://mock:3210');

  const addresses = lanAddresses();
  const primary = addresses[0]?.split(' ')[0] ?? '<this-host-ip>';

  console.log('\n  Gateway provisioned: one pool, one key, one model.\n');
  console.log('  Reachable on this host at:');
  for (const a of addresses) console.log(`    http://${a.replace(/\s+\(/, ':' + GATEWAY_HOST_PORT + '  (')}`);
  console.log('');
  console.log('  ── On the LOAD GENERATOR machine ────────────────────────────────────────────');
  console.log('');
  console.log('  Measure the gateway:');
  console.log(`    RATE=400 DURATION=20s PRE_VUS=400 MAX_VUS=2000 \\`);
  console.log(`      TARGET_URL=http://${primary}:${GATEWAY_HOST_PORT}/v1/chat/completions \\`);
  console.log(`      API_KEY=${apiKey} \\`);
  console.log('      k6 run scripts/bench/k6/openLoop.js');
  console.log('');
  console.log('  And the rig\'s own ceiling — the SAME network, gateway removed from the path.');
  console.log('  Run this every time. A gateway figure approaching it is measuring the rig:');
  console.log(`    RATE=3000 DURATION=15s PRE_VUS=600 MAX_VUS=2000 \\`);
  console.log(`      TARGET_URL=http://${primary}:3210/v1/chat/completions \\`);
  console.log(`      API_KEY=${apiKey} \\`);
  console.log('      k6 run scripts/bench/k6/openLoop.js');
  console.log('');
  console.log('  Closed-loop comparison (set VUS instead of RATE), which is how the coordinated-');
  console.log('  omission claim is checked rather than asserted:');
  console.log(`    VUS=64 DURATION=20s TARGET_URL=http://${primary}:${GATEWAY_HOST_PORT}/v1/chat/completions \\`);
  console.log(`      API_KEY=${apiKey} k6 run scripts/bench/k6/openLoop.js`);
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
