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

// The shape of columnFacts.generated.ts, in a file the generator does not overwrite.
//
// Separate from both so that the generated module and scripts/db/columnFacts.ts share one
// definition rather than each declaring its own. Two copies of a four-value union look harmless
// right up until one of them gains a case.

/** `req`/`opt` and `def`/`nodef` for one column — the two facts Prisma 7's DMMF stopped reporting. */
export type ColumnFact = `${'req' | 'opt'}:${'def' | 'nodef'}`;

/** Every model's columns, keyed by the model name the DMMF uses. */
export type ColumnFacts = Record<string, Record<string, ColumnFact>>;

/**
 * Each model's primary-key columns.
 *
 * A list rather than a single name so that a composite `@@id([a, b])` is representable. Prisma 7
 * removed both `isId` and `primaryKey` from the DMMF, so this is the only place left that knows.
 */
export type ModelKeys = Record<string, string[]>;
