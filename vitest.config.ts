import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // scripts/ is covered too: the seed generator is pure, deterministic logic whose output ends up
    // in the README's screenshots and the public demo's fixtures, so it earns the same gate as src/.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Generates the PostgreSQL DDL the parity suites share, once per run; a no-op without them.
    globalSetup: ['./test/parityGlobalSetup.ts'],
  },
});
