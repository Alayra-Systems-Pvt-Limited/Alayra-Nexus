import { defineConfig, devices } from '@playwright/test';
import { STANDALONE_BASE_URL } from './setup/standalone';

export default defineConfig({
  testDir: './tests/standalone',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './setup/standalone.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: STANDALONE_BASE_URL,
  },
});
