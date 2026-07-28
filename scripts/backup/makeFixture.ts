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
 */

// Write the committed format fixture (Phase B1.2b).
//
//   npm run backup:fixture
//
// RUN THIS ALMOST NEVER. The fixture exists to prove that a backup written by an older build still
// opens today, so regenerating it destroys the only evidence of that. It is regenerated when the
// format version is deliberately raised — and then the OLD fixture stays, so both versions are
// covered — never to make a failing test pass.
//
// If src/lib/backup/formatStability.test.ts fails, the format changed. That is the finding. Either
// the change was unintended and belongs reverted, or it was intended and needs a version bump plus a
// reader for the old version.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Writable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { writeBackup } from '../../src/lib/backup/export';
import { MODEL_ORDER } from '../../src/lib/backup/modelOrder';

// Must match formatStability.test.ts.
const PASSPHRASE = 'the-fixture-passphrase-v1';
const OUT = resolve(__dirname, '..', '..', 'src', 'lib', 'backup', '__fixtures__', 'v1-backup.nxb');

/**
 * Deliberately fake data, and deliberately NOT encrypted with a master key.
 *
 * This file is committed to a public repository. The "secrets" in it are plainly fictional strings,
 * and because export DECRYPTS on the way in, a fixture carrying real ciphertext would have had to be
 * built from a real gateway — so the rows here are written as if already decrypted.
 */
const ROWS: Record<string, Record<string, unknown>[]> = {
  nexusProvider: [{ id: 'p-fixture', name: 'Fixture provider', slug: 'fixture', provider: 'openai', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
  team:          [{ id: 't-fixture', name: 'Fixture team', createdAt: new Date('2026-01-02T00:00:00.000Z') }],
  appSettings:   [{ id: 's-fixture', key: 'FIXTURE_SETTING', value: '{"kept":true}' }],
};

function fakeClient(): PrismaClient {
  const client: Record<string, unknown> = {};
  for (const model of MODEL_ORDER) {
    const rows = ROWS[model] ?? [];
    client[model] = {
      findMany: (args: { take: number; cursor?: { id: string }; skip?: number }) => {
        const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
        return Promise.resolve(rows.slice(start, start + args.take));
      },
    };
  }
  return client as unknown as PrismaClient;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });

  // No gateway recipient: it would be wrapped with whatever MASTER_ENCRYPTION_KEY happened to be
  // set when this ran, which is not reproducible and would make the fixture open on one machine and
  // not another. The passphrase recipient is the part worth freezing.
  const summary = await writeBackup({
    client: fakeClient(), engine: 'postgres', passphrase: PASSPHRASE,
    out, gatewayVersion: 'fixture', includeGatewayRecipient: false,
    // Pinned, not read from this process (C1, C5). A fixture that recorded the real schema shape
    // would change every time the schema did, and one that recorded this machine's environment
    // would open here and fail on a colleague's — a format fixture failing for reasons that have
    // nothing to do with the format.
    schema: { Fixture: ['id:String:req:def'] },
    env: [],
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.concat(chunks));
  console.log(`Wrote ${OUT} — ${summary.totalRows} rows, ${Buffer.concat(chunks).length} bytes.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
