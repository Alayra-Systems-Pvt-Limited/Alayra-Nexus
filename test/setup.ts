// Test-only environment bootstrap. Runs before each test file so modules that
// read configuration at import time (e.g. src/lib/encryption.ts) load cleanly.
// This is a throwaway key for the test process only — never a real secret.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? 'a'.repeat(64);
