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

// ── What an adapter author supplies, and what a check is (P0.5c) ─────────────────────────────

import type { CoreStores, NotificationRow } from '../ports';
import type { CoreFixture } from './fixture';

/**
 * How the checks reach an adapter. The ports are mostly read-only by design (pools and keys are an
 * operator's business), so the harness, not the ports, writes the fixture.
 */
export interface CoreStoresHarness {
  /** Fresh storage holding exactly `fixture` and nothing else, and the stores over it. Called once per check. */
  setup(fixture: CoreFixture): Promise<CoreStores>;
  /** Every notification stored since the last setup, oldest first. The sink port is write-only. */
  notifications(): Promise<NotificationRow[]>;
}

/** One check. Throws (a node:assert AssertionError) when the adapter does not conform. */
export interface ConformanceCase {
  name: string;
  run(harness: CoreStoresHarness): Promise<void>;
}
