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

// ── `@alayrasystems/nexus-core/testing` (P0.5c) ───────────────────────────────────────────────
// For anyone writing storage for the core: the conformance checks every adapter must pass, the
// fixed fixture they run against, and an in-memory reference implementation. Kept out of the main
// entry so a production host never loads test code.

export { coreStoresConformance, runCoreStoresConformance } from './conformance';
export type { ConformanceCase, CoreStoresHarness } from './conformanceTypes';
export {
  CONFORMANCE_FIXTURE, T0, hoursAfterT0,
  type CoreFixture, type FixtureTeam, type FixtureTeamKey, type FixtureProvider, type FixtureKey,
} from './fixture';
export { createMemoryCoreStores, type MemoryCoreStores } from './memoryStores';
