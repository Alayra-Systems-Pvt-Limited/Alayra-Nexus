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

// ── Notification sink port ────────────────────────────────────────────────────
// Where an operator alert raised on the request path (a key banned, a breaker opened, a budget
// crossed, every key exhausted) is recorded. Coalescing happens before this is called, so the sink
// only stores. Reading and clearing the feed is the dashboard's business, not the core's.

/** One alert, ready to store. */
export interface NotificationRow {
  id:        string;
  type:      string;
  severity:  string;
  title:     string;
  body:      string;
  section:   string | null;
  dedupeKey: string;
}

export interface NotificationSink {
  record(row: NotificationRow): Promise<void>;
}
