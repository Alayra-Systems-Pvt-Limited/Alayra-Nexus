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
