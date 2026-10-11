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

// ── Recording an alert in the in-app feed ───────────────────────────────────────────────────
// The write half of the alert feed (Phase 7.11), split out of notificationFeed.service.ts (P0.5a).
// It reaches storage only through the NotificationSink port, so the request path can raise an
// alert without importing a database client. Reading, marking and pruning the feed stay in
// notificationFeed.service.ts, which the dashboard uses.

import { randomUUID } from 'crypto';
import { coreStores } from '../core/stores';
import { redis }      from '../lib/redis';
import { sectionFor, type NotifyMessage } from '../lib/notify';

// A separate namespace from the send guard (`nexus:notify:sent:`) on purpose. The send path
// *releases* its claim when a configured channel failed, so the next occurrence can retry the
// email — sharing one key would make that release re-insert a duplicate feed entry for an alert
// already sitting in the bell.
const FEED_CLAIM_PREFIX = 'nexus:notify:feed:';

/**
 * Record an alert in the feed, coalesced per window by its `dedupeKey` exactly as delivery is, so a
 * flapping key leaves one entry rather than a storm. Returns whether a row was actually written
 * (false = an identical alert is already in this window). Never throws: the feed is an operator
 * convenience and must never disturb the caller, which is always fire-and-forget off the hot path.
 */
export async function recordNotification(msg: NotifyMessage, windowSeconds: number): Promise<boolean> {
  try {
    const claimed = await redis.set(`${FEED_CLAIM_PREFIX}${msg.dedupeKey}`, '1', 'EX', windowSeconds, 'NX');
    if (claimed === null) return false;
    await (await coreStores()).notifications.record({
      id:        randomUUID(),
      type:      msg.type,
      severity:  msg.severity,
      title:     msg.title,
      body:      msg.body,
      section:   sectionFor(msg.type),
      dedupeKey: msg.dedupeKey,
    });
    return true;
  } catch {
    return false;
  }
}
