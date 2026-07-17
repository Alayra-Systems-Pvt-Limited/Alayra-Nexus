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

import { defineConfig, devices } from '@playwright/test';
import { stack } from './setup/stacks';

// One worker, no parallelism, no retries — all three deliberate, all three unusual.
//
// The suites are STORIES, not independent specs: claim the gateway, then sign in, then
// invite, then remove. Each step's precondition is the previous step's outcome, which is
// exactly what "end to end" means — parallel workers would race each other through a
// single shared gateway's state.
//
// And no retries because a retry policy is a flakiness amnesty: a test that passes on its
// second attempt is reporting a real intermittent failure and calling it green. This suite
// exists because three shipped bugs were found by humans clicking; it cannot itself be
// allowed to look away. If a spec here flakes, the spec (or the product) is wrong — fix it.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './setup/global.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  projects: [
    {
      // The wire: real HTTP against the compiled server. No browser involved.
      name: 'api',
      testDir: './tests/api',
      use: { baseURL: stack('api').baseURL },
    },
    {
      // The dashboard: a real browser driving the same artifact a deployment serves.
      name: 'browser',
      testDir: './tests/browser',
      use: { ...devices['Desktop Chrome'], baseURL: stack('ui').baseURL },
    },
  ],
});
