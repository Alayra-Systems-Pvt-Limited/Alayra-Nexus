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

import { getSetting, setSetting } from './settings.service';
import { ssrfPolicyFromEnv, parseAllowList, type SsrfPolicy } from '../lib/url';

// Resolves the live SSRF policy from environment defaults plus the operator's
// dashboard-editable overrides. Settings are Redis-cached in settings.service, so
// reading the policy on the request path is a cached lookup, not a DB hit.
//
// Merge rules:
//   • allowPrivate — the dashboard toggle wins when set; otherwise the env default.
//   • allowList    — union of the env baseline and the dashboard-added hosts, so a
//                    host configured either way is permitted.

export const SETTING_ALLOW_PRIVATE = 'SSRF_ALLOW_PRIVATE';
export const SETTING_ALLOWLIST     = 'SSRF_ALLOWLIST';

export async function getSsrfPolicy(): Promise<SsrfPolicy> {
  const env = ssrfPolicyFromEnv();
  const [allowPrivateSetting, allowListSetting] = await Promise.all([
    getSetting(SETTING_ALLOW_PRIVATE),
    getSetting(SETTING_ALLOWLIST),
  ]);

  const allowPrivate = allowPrivateSetting === null
    ? env.allowPrivate
    : /^(1|true|yes|on)$/i.test(allowPrivateSetting.trim());

  const allowList = new Set(env.allowList);
  for (const host of parseAllowList(allowListSetting)) allowList.add(host);

  return { allowPrivate, allowList };
}

/** The persisted (dashboard) overrides plus the read-only env baseline, for the UI. */
export async function getSsrfConfig(): Promise<{
  allowPrivate: boolean;
  allowList:    string[];
  envAllowList: string[];
}> {
  const env = ssrfPolicyFromEnv();
  const [allowPrivateSetting, allowListSetting] = await Promise.all([
    getSetting(SETTING_ALLOW_PRIVATE),
    getSetting(SETTING_ALLOWLIST),
  ]);
  return {
    allowPrivate: allowPrivateSetting === null ? env.allowPrivate : /^(1|true|yes|on)$/i.test(allowPrivateSetting.trim()),
    allowList:    [...parseAllowList(allowListSetting)],
    envAllowList: [...env.allowList],
  };
}

export async function setSsrfConfig(allowPrivate: boolean, allowList: string[]): Promise<void> {
  const normalized = [...parseAllowList(allowList.join(','))];
  await Promise.all([
    setSetting(SETTING_ALLOW_PRIVATE, allowPrivate ? 'true' : 'false'),
    setSetting(SETTING_ALLOWLIST, normalized.join(',')),
  ]);
}
