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

// How a DateTime is written into a SQLite file (Prisma 7).
//
// ── Its own module, deliberately ──────────────────────────────────────────────────────────────
//
// This belongs next to the client in lib/prisma.ts by subject, and cannot live there. That module
// CONSTRUCTS a client when it is imported, so every suite that wants a different database mocks it
// wholesale — and a constant living behind a mock is a constant that vanishes in exactly the tests
// that need it. Left there, `migrateCopy.parity.test.ts` failed with "No SQLITE_TIMESTAMP_FORMAT
// export is defined on the ../prisma mock", and the fix would have been to teach every mock about a
// value none of them care about. Here there is nothing to mock: no side effects, no client, no
// environment read.

/**
 * The storage format for SQLite DateTime columns. THIS IS A FILE FORMAT, not a preference.
 *
 * Prisma 7's better-sqlite3 adapter defaults to `iso8601`, storing a DateTime as TEXT
 * ("2026-03-03T12:00:00.000Z"). Every gateway that has ever run standalone holds INTEGER epoch
 * milliseconds, which is what Prisma 5 and 6 wrote. Taking the new default would not convert those
 * rows — it would start appending rows in the other format to the same column, and SQLite is happy
 * to let one column hold both.
 *
 * That is worse than a clean break, because nothing errors:
 *
 *   • `sqliteDay` buckets with `date(col/1000, 'unixepoch')`. Dividing text by 1000 gives 0, so
 *     every row written after the upgrade reports as 1970-01-01. Measured — it is what turned five
 *     analytics parity tests red, and on a real gateway it would have been a dashboard quietly
 *     losing recent traffic into an empty 1970 bucket.
 *
 *   • Range filters degrade more quietly still. SQLite orders values by storage class before value,
 *     so every INTEGER sorts below every TEXT no matter what dates they hold. A "last 7 days" query
 *     over a mixed column returns a wrong answer with no error anywhere.
 *
 * Pinned rather than migrated because pinning is the change that does nothing: existing files stay
 * readable, the dialect twins stay correct, and upgrading stays something an operator does by
 * replacing a binary. Moving to `iso8601` would mean rewriting every timestamp in every standalone
 * database and rewriting the SQL that reads them, for no gain.
 */
export const SQLITE_TIMESTAMP_FORMAT = 'unixepoch-ms' as const;

/** The second argument to PrismaBetterSqlite3. Here so every construction site agrees on it. */
export type SqliteAdapterOptions = { timestampFormat?: 'iso8601' | 'unixepoch-ms' };
