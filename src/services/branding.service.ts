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

// Operator branding (Phase 7.11): the side-effect half — read and write the setting. Stored in
// AppSettings rather than its own table: it is one small singleton blob, which is exactly what that
// key/value store is for, so this feature needs no migration.

import { getSetting, setSetting } from './settings.service';
import { normalizeBranding, type BrandingConfig } from '../lib/branding';

const SETTING_KEY = 'BRANDING_CONFIG';

/** The current branding. Safe to expose publicly: a company name and logo on a sign-in page are
 *  intended to be seen before anyone authenticates — that is the entire point of branding it. */
export async function getBranding(): Promise<BrandingConfig> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return normalizeBranding(null);
  try { return normalizeBranding(JSON.parse(raw)); }
  catch { return normalizeBranding(null); }
}

/** Persist branding. Fields are merged, so setting a name does not silently clear a logo; an
 *  explicit empty string is how either is removed. */
export async function setBranding(input: Partial<BrandingConfig>): Promise<BrandingConfig> {
  const existing = await getBranding();
  const merged = normalizeBranding({
    companyName: input.companyName ?? existing.companyName,
    logoDataUri: input.logoDataUri ?? existing.logoDataUri,
  });
  await setSetting(SETTING_KEY, JSON.stringify(merged));
  return merged;
}
