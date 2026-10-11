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

// ── Prisma settings store ─────────────────────────────────────────────────────
// The AppSettings key/value table. Caching stays in services/settings.service.ts.

import { prisma } from '../../lib/prisma';
import type { SettingsStore } from '../../core/ports';

export const prismaSettingsStore: SettingsStore = {
  get: async (key) => {
    const row = await prisma.appSettings.findUnique({ where: { key } });
    return row?.value ?? null;
  },

  set: async (key, value) => {
    await prisma.appSettings.upsert({
      where:  { key },
      create: { key, value },
      update: { value },
    });
  },
};
