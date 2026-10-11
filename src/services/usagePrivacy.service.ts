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

// ── Usage anonymization flag ──────────────────────────────────────────────────────────────────
// Whether usage rows are de-identified (Phase 6.7). Read per request on the usage hot path, so it
// lives apart from audit.service.ts (P0.5a): the request path needs this one flag, not the audit
// writer and its database client. The compliance settings page writes it through audit.service.

import { getSetting } from './settings.service';

export const SETTING_ANONYMIZE_USAGE = 'ANONYMIZE_USAGE';

const isOn = (v: string | null): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim());

// ── In-process memo ───────────────────────────────────────────────────────────────────────────
// Memoized for a few seconds on top of the Redis-cached setting: a config change still takes
// effect promptly, but a request never blocks on it.
let anonMemo = { value: false, at: 0 };
const ANON_MEMO_MS = 30_000;

/** Whether usage records should be de-identified. Cheap enough to call per request. */
export async function isUsageAnonymized(): Promise<boolean> {
  const now = Date.now();
  if (now - anonMemo.at < ANON_MEMO_MS) return anonMemo.value;
  anonMemo = { value: isOn(await getSetting(SETTING_ANONYMIZE_USAGE)), at: now };
  return anonMemo.value;
}

/** Called right after the setting is saved, so the change applies at once rather than after the memo. */
export function rememberUsageAnonymized(value: boolean): void {
  anonMemo = { value, at: Date.now() };
}
