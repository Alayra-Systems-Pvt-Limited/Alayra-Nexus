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

// ── Core storage ports ────────────────────────────────────────────────────────
// The full set of storage the gateway core depends on. A host (the open-source server, or the
// hosted gateway) supplies one implementation of each; the core never imports a database client.

import type { KeyStore }         from './keyStore';
import type { ProviderStore }    from './providerStore';
import type { UsageStore }       from './usageStore';
import type { SettingsStore }    from './settingsStore';
import type { NotificationSink } from './notificationSink';

export type { KeyStore, KeyRow, KeyAlertFacts, KeyStateRow, KeyCheck } from './keyStore';
export type { ProviderStore, ProviderRow, PreferredModelPool, ProviderCheckRow, ProviderCheck } from './providerStore';
export type { UsageStore, UsageRow } from './usageStore';
export type { SettingsStore } from './settingsStore';
export type { NotificationSink, NotificationRow } from './notificationSink';

export interface CoreStores {
  keys:          KeyStore;
  providers:     ProviderStore;
  usage:         UsageStore;
  settings:      SettingsStore;
  notifications: NotificationSink;
}
