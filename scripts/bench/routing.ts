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

// What does routing cost when keys run out and the router has to walk?
//
//   docker run -d --name nexus-ops-redis -p 56379:6379 redis:7-alpine
//   npm run build && npm run bench:routing
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
//
// Every other benchmark here uses ONE pool with ONE key whose limits are set to 100,000,000 — high
// enough that nothing is ever refused. That is right for measuring proxy overhead, because a run
// that spends half its requests being turned away at 429 reports a wonderful latency for work the
// gateway declined to do.
//
// It is also the easiest possible path through the router, and it is not what a real deployment does.
// The product's whole claim is that when a key runs out of RPM or TPM the request rolls to the next
// key, then the next pool, without the caller noticing. That roll-over has never been measured — not
// its correctness and not its cost.
//
// Two things are in question and they are different:
//
//   Does it work?     when key 1 is exhausted, does the request still succeed on key 2?
//   What does it cost? the router checks each candidate with a breaker gate, a user-admission call
//                      and an atomic RPM/TPM reservation — three Redis round trips PER KEY TRIED,
//                      plus one database read per POOL tried. If that is the shape, cost grows
//                      exactly when the system is under pressure, which is the worst possible time.
//
// So this creates several pools with deliberately TINY limits, drives enough traffic to exhaust them
// in order, and reports the per-request cost as the walk gets deeper.

import { execFileSync } from 'node:child_process';
import { completionBody, startHarness, setUpstream } from './gateway';

const REDIS_CONTAINER = process.env.OPS_REDIS_CONTAINER ?? 'nexus-ops-redis';
const REDIS_PORT = parseInt(process.env.OPS_REDIS_PORT ?? '56379', 10);

/** Pools to create, each with one key. */
const POOLS = parseInt(process.env.ROUTING_POOLS ?? '5', 10);
/** Requests each key will accept before it is out of headroom. Small, so the walk is quick to reach. */
const RPM_PER_KEY = parseInt(process.env.ROUTING_RPM ?? '10', 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const redisCli = (args: string[]): string =>
  execFileSync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', ...args], { encoding: 'utf8' });

interface Cost { requests: number; redis: number; ok: number; failed: number }

function commandTotal(): number {
  let total = 0;
  for (const line of redisCli(['info', 'commandstats']).split(/\r?\n/)) {
    const m = /^cmdstat_[a-z|]+:calls=(\d+)/.exec(line.trim());
    if (m?.[1]) total += parseInt(m[1], 10);
  }
  return total;
}

async function main(): Promise<void> {
  redisCli(['flushall']);
  const h = await startHarness(3210, 3401, { redisUrl: `redis://127.0.0.1:${REDIS_PORT}/0` });

  try {
    await setUpstream(h.mockUrl, { latencyMs: 0 });

    // Extra pools beyond the one the harness already made, each with a key limited hard enough that
    // a handful of requests exhausts it. Same provider slug is fine — routing walks pools, and what
    // is being measured is the walk.
    for (let i = 1; i < POOLS; i++) {
      const pool = await fetch(`${h.gatewayUrl}/admin/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
        body: JSON.stringify({
          name: `Bench Pool ${i}`, slug: `bench-${i}`, provider: 'custom', tier: 'standard',
          baseUrl: `${h.mockUrl}/v1`, authHeader: 'Authorization', authPrefix: 'Bearer ',
        }),
      }).then((r) => r.json() as Promise<{ provider?: { id: string } }>);

      const id = pool.provider?.id;
      if (!id) throw new Error(`could not create pool ${i}`);

      await fetch(`${h.gatewayUrl}/admin/providers/${id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
        body: JSON.stringify({
          apiKey: `sk-bench-${i}`, label: `bench key ${i}`,
          rpmLimit: RPM_PER_KEY, tpmLimit: 10_000_000,
        }),
      });
    }

    // Clamp EVERY key to the same small limit, the harness's included, so pool 0 exhausts like the
    // rest instead of absorbing the whole run.
    //
    // The first version fetched `/admin/keys`, which does not exist — keys are listed under their
    // provider. The 404 produced `undefined`, the clamp silently never ran, the harness key kept its
    // 100,000,000 rpm and served every request, and this script reported a beautifully flat cost
    // curve for a walk that never happened. Hence the assertion below: a setup step that quietly
    // does nothing is worse than one that fails loudly.
    const providers = await fetch(`${h.gatewayUrl}/admin/providers`, {
      headers: { authorization: `Bearer ${h.adminToken}` },
    }).then((r) => r.json() as Promise<{ providers?: { id: string }[] }>);

    let clamped = 0;
    for (const p of providers.providers ?? []) {
      const keys = await fetch(`${h.gatewayUrl}/admin/providers/${p.id}/keys`, {
        headers: { authorization: `Bearer ${h.adminToken}` },
      }).then((r) => r.json() as Promise<{ keys?: { id: string }[] }>);

      for (const k of keys.keys ?? []) {
        const res = await fetch(`${h.gatewayUrl}/admin/keys/${k.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
          body: JSON.stringify({ rpmLimit: RPM_PER_KEY, tpmLimit: 10_000_000 }),
        });
        if (res.ok) clamped++;
      }
    }

    if (clamped < POOLS) {
      throw new Error(
        `only ${clamped} of ${POOLS} keys were clamped to ${RPM_PER_KEY} rpm. Without every key ` +
        'limited, one of them absorbs the whole run and no walk is measured.',
      );
    }
    console.log(`clamped ${clamped} keys to ${RPM_PER_KEY} rpm`);

    console.log(`\n${POOLS} pools, one key each, ${RPM_PER_KEY} rpm per key.`);
    console.log(`Total headroom: ${POOLS * RPM_PER_KEY} requests before everything is exhausted.\n`);

    let n = 0;
    const send = async (): Promise<number> => {
      const r = await fetch(`${h.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
        // Unique per request: an identical body pins to one key via sticky routing and never walks
        // at all, which is exactly the blind spot this script exists to remove.
        body: JSON.stringify(completionBody(n++)),
      });
      await r.text();
      return r.status;
    };

    // Warm up so the caches this is not trying to measure are populated.
    for (let i = 0; i < 3; i++) await send();
    await sleep(1_000);

    // One band per key's worth of headroom. Band 0 should be served by the first key, band 1 after
    // it is exhausted, and so on — each band walking one pool deeper than the last.
    const bands: Cost[] = [];
    for (let band = 0; band < POOLS + 1; band++) {
      redisCli(['config', 'resetstat']);
      const before = commandTotal();
      let ok = 0; let failed = 0;

      for (let i = 0; i < RPM_PER_KEY; i++) {
        const status = await send();
        if (status === 200) ok++; else failed++;
      }
      await sleep(300);

      const redis = commandTotal() - before;
      bands.push({ requests: RPM_PER_KEY, redis, ok, failed });
      console.log(
        `  band ${band}: ${ok} ok, ${failed} refused — ` +
        `${(redis / RPM_PER_KEY).toFixed(1)} Redis ops per request`,
      );
    }

    console.log('\n| band | expected depth | ok | refused | Redis ops / request |');
    console.log('|---|---|---|---|---|');
    bands.forEach((b, i) => {
      console.log(`| ${i} | pool ${Math.min(i, POOLS - 1)} | ${b.ok} | ${b.failed} | ${(b.redis / b.requests).toFixed(1)} |`);
    });

    const shallow = bands[0];
    const deep = bands[bands.length - 2];
    if (shallow && deep) {
      const growth = (deep.redis / deep.requests) / (shallow.redis / shallow.requests);
      console.log('');
      console.log(
        `Cost from the first band to the deepest served one grew ${growth.toFixed(2)}x. ` +
        'Growth here means the router pays per key it has to reject, which is a cost that arrives ' +
        'exactly when capacity is tight.',
      );
    }
    console.log('');
  } finally {
    h.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
