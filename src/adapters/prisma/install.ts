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

// ── Install the Prisma stores ─────────────────────────────────────────────────
// Called once by every open-source entry point (the server, the test setup, scripts that drive
// services directly). This module deliberately imports only the registry: the adapters, and with
// them the Prisma client, load on the first storage call. A unit test that mocks lib/prisma
// therefore still has its mock reach the adapters, because nothing loaded the real client first.

import { configureCoreStores } from '../../core/stores';

export function installPrismaCoreStores(): void {
  configureCoreStores(async () => (await import('./index')).prismaCoreStores);
}
