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

// ── Settings store port ───────────────────────────────────────────────────────
// Durable key/value settings (routing weights, cache switches, compliance flags). Caching in front
// of it stays in the settings service; the store is only the source of truth.

export interface SettingsStore {
  /** The stored value, or null when the key has never been set. */
  get(key: string): Promise<string | null>;

  /** Create or overwrite one setting. */
  set(key: string, value: string): Promise<void>;
}
