import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test-only environment bootstrap. Runs before each test file so modules that
// read configuration at import time (e.g. src/lib/encryption.ts) load cleanly.
// This is a throwaway key for the test process only — never a real secret.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? 'a'.repeat(64);

// Pin the unit suite to the Postgres client (Phase S2). Without this, an environment with no
// DATABASE_URL — which is exactly what CI is — now resolves to SQLite, so every test file that
// imports lib/prisma would build a SQLite client and create a `.nexus/` directory as a side effect
// of merely being loaded. Nothing here connects to it either way (Prisma constructs lazily and the
// service tests mock the client), so this only keeps the suite on the engine it has always used and
// off the filesystem. Tests that specifically exercise SQLite set their own URL.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://nexus:nexus@localhost:5432/nexus';

// Point every secret-file write at a throwaway directory, ALWAYS — not `??`, because the whole
// point is to override whatever the developer's shell has.
//
// This is not defensive tidiness; it fixes real data loss. convertLegacyApiKey() writes the
// gateway's one retrievable copy of the master API key to <data dir>/api-key.txt, and its unit test
// drives it with a mocked settings store — so running `npm test` on a machine that also runs a
// gateway overwrote that machine's REAL .nexus/api-key.txt with the test's fake key. The gateway
// keeps working (only a hash is stored server-side), but the operator's single chance to read their
// key is gone, and nothing anywhere says so. Found while running the release gate against a local
// gateway: the key file it read back was the string 'legacykey0000…abcd' from apiKey.service.test.ts.
//
// mkdtemp rather than a fixed path so parallel vitest workers cannot fight over one directory.
process.env.NEXUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'nexus-test-'));
