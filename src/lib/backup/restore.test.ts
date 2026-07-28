/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Restore's behaviour is proven end to end against real databases in
// src/lib/parity/backup.parity.test.ts, which is where a genuine unique index and a genuine
// transaction live. What is left here is the one guard that suite CANNOT reach.
//
// `assertNothingDropped` fires when a `replace` restore writes fewer rows than it read. That is
// impossible through readBackup — every table was emptied moments earlier inside the same
// transaction, so there is nothing left to collide with — and being unreachable is exactly the
// point of it. It is a check on OUR code being wrong, not on the operator's file being wrong.
//
// Which leaves the problem this file solves: an assertion that has never been observed to fire is
// indistinguishable from one that does not work. So it is called directly, both ways.

import { describe, it, expect } from 'vitest';
import { Writable, Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { assertNothingDropped, readBackup } from './restore';
import { writeBackup } from './export';
import { MODEL_ORDER } from './modelOrder';

/** Per-model counts, defaulting every other model to zero the way readBackup does. */
function counts(over: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])), ...over };
}

describe('assertNothingDropped', () => {
  it('passes when every row landed', () => {
    expect(() => assertNothingDropped(counts({ appSettings: 3 }), counts({ appSettings: 3 }))).not.toThrow();
  });

  it('passes when the file was empty', () => {
    expect(() => assertNothingDropped(counts(), counts())).not.toThrow();
  });

  it('throws when a row went missing', () => {
    expect(() => assertNothingDropped(counts({ appSettings: 3 }), counts({ appSettings: 2 })))
      .toThrow(/appSettings \(1 of 3 missing\)/);
  });

  it('names every model that lost rows, not just the first', () => {
    // A restore that dropped rows from three tables and named one would send somebody looking in
    // the wrong place.
    const before = counts({ appSettings: 3, adminUser: 2, tokenUsage: 10 });
    const after = counts({ appSettings: 1, adminUser: 0, tokenUsage: 10 });

    try {
      assertNothingDropped(before, after);
      throw new Error('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('appSettings (2 of 3 missing)');
      expect(message).toContain('adminUser (2 of 2 missing)');
      expect(message).not.toContain('tokenUsage');   // this one was fine
    }
  });

  it('says the gateway is unchanged, because it is', () => {
    // It throws from inside the transaction, so the rollback is what makes this true. An operator
    // reading a restore failure needs to know whether they are now holding half a gateway.
    expect(() => assertNothingDropped(counts({ appSettings: 1 }), counts({ appSettings: 0 })))
      .toThrow(/Nothing has been changed/);
  });

  it('does not fire when MORE rows were written than read', () => {
    // Nonsense input rather than a real case, but the guard is about a SHORTFALL. Treating "more"
    // as a failure would turn a counting bug of ours into a refusal to restore.
    expect(() => assertNothingDropped(counts({ appSettings: 1 }), counts({ appSettings: 2 }))).not.toThrow();
  });
});

// ── What the transaction is actually asked for (A3) ───────────────────────────────────────────
//
// `timeout` and `maxWait` were the same value. That was harmless while the budget was two minutes
// and a bug the moment it became thirty: `maxWait` is how long to wait for a free connection from
// the pool, so coupling them meant a gateway whose pool was momentarily busy would sit for half an
// hour before starting any work at all.
//
// Nothing else in the suite can see that. The parity tests observe the timeout because it expires,
// but a wrong `maxWait` produces no failure — only a wait nobody is present for. So the options are
// asserted directly, against a client that records them.

const PASS = 'a-long-enough-backup-passphrase';

/** A backup file with two secret-free rows in it, built in memory. */
async function tinyBackup(): Promise<Buffer> {
  const rows: Record<string, Record<string, unknown>[]> = {
    team:        [{ id: 't1', name: 'Team' }],
    appSettings: [{ id: 's1', key: 'SOMETHING_HARMLESS', value: '{}' }],
  };
  const client: Record<string, unknown> = {};
  for (const model of MODEL_ORDER) {
    client[model] = {
      findMany: (args: { take: number; cursor?: { id: string } }) =>
        Promise.resolve(args.cursor ? [] : (rows[model] ?? []).slice(0, args.take)),
    };
  }

  const chunks: Buffer[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  await writeBackup({
    client: client as unknown as PrismaClient, engine: 'postgres', passphrase: PASS,
    out, gatewayVersion: 'test', includeGatewayRecipient: false,
  });
  return Buffer.concat(chunks);
}

/** Records what `$transaction` was asked for, then runs the body against inert delegates. */
function recordingClient(): { client: PrismaClient; options: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {};

  const tx: Record<string, unknown> = {};
  for (const model of MODEL_ORDER) {
    tx[model] = { createMany: (a: { data: unknown[] }) => Promise.resolve({ count: a.data.length }) };
  }

  const client = {
    $transaction: async (body: (t: unknown) => Promise<void>, opts: Record<string, unknown>) => {
      seen = opts;
      await body(tx);
    },
  };
  return { client: client as unknown as PrismaClient, options: () => seen };
}

describe('the transaction options a restore asks for', () => {
  it('waits for a pool connection for its own short budget, not the whole restore budget', async () => {
    const { client, options } = recordingClient();
    await readBackup({
      client, engine: 'postgres', passphrase: PASS,
      input: Readable.from(await tinyBackup()), mode: 'merge', timeoutMs: 30 * 60 * 1000,
    });

    expect(options().timeout).toBe(30 * 60 * 1000);
    expect(options().maxWait).toBe(10_000);
    // The property that matters, stated as itself: these are different quantities.
    expect(options().maxWait).not.toBe(options().timeout);
  });

  it('keeps maxWait fixed however large the restore budget grows', async () => {
    const { client, options } = recordingClient();
    await readBackup({
      client, engine: 'postgres', passphrase: PASS,
      input: Readable.from(await tinyBackup()), mode: 'merge', timeoutMs: 6 * 60 * 60 * 1000,
    });

    expect(options().maxWait).toBe(10_000);
  });

  it('falls back to a conservative budget when a library caller passes none', async () => {
    const { client, options } = recordingClient();
    await readBackup({
      client, engine: 'postgres', passphrase: PASS,
      input: Readable.from(await tinyBackup()), mode: 'merge',
    });

    expect(options().timeout).toBe(120_000);
  });
});
