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

// ── Key routing order ─────────────────────────────────────────────────────────
// Shared by the key store (which keys to try) and the provider store (which key an operator check
// uses), so the two can never disagree. Its own module because the key store already imports the
// provider store; defining it in either would make the import circular.

import type { Prisma } from '@prisma/client';

/**
 * The routing order: never-used keys first, then least recently used, ties by id. NULL placement
 * is spelled out because the engines disagree on their own (PostgreSQL sorts NULL last, SQLite
 * first), which left a new key idle on PostgreSQL until every other key had been used (#195).
 */
export const KEY_ROUTING_ORDER: Prisma.NexusKeyOrderByWithRelationInput[] = [
  { lastUsedAt: { sort: 'asc', nulls: 'first' } },
  { id: 'asc' },
];
