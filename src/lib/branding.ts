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

// ── Operator branding: the pure core (Phase 7.11) ────────────────────────────
// An operator's own company name and logo on the dashboard and the sign-in screen. This module is
// the decision half — the shape, its normalization, and the logo validation — all pure and tested.
// Reading and writing the setting lives in branding.service.
//
// The logo is stored as a **data URI**, not a URL. This gateway deliberately self-hosts its assets
// (the Chart.js CDN was removed precisely because it broke air-gapped and strict-CSP deployments);
// a remote logo URL would reintroduce that, and would additionally leak a request to a third party
// on every load of a *public* sign-in page. A data URI is served from our own origin, always.

export interface BrandingConfig {
  /** Shown beside the logo; '' means fall back to the product's own name. */
  companyName: string;
  /** A base64 image data URI; '' means fall back to the product's own mark. */
  logoDataUri: string;
}

export const DEFAULT_BRANDING: BrandingConfig = { companyName: '', logoDataUri: '' };

export const MAX_COMPANY_NAME = 60;
export const MAX_LOGO_BYTES   = 64 * 1024;

/**
 * SVG is allowed because the logo is only ever rendered through an `<img src=…>`, which browsers
 * treat as "secure static mode": scripts, external references and interactivity inside the SVG are
 * all inert there. It must never be inlined into the DOM, where that would stop being true.
 */
const LOGO_DATA_URI = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Decoded byte length of a base64 payload, without allocating it. */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export type LogoCheck = { ok: true } | { ok: false; error: string };

/** Validate an uploaded logo. '' is valid and means "no logo" — that is how one is removed. */
export function validateLogoDataUri(value: string): LogoCheck {
  if (value === '') return { ok: true };
  const m = LOGO_DATA_URI.exec(value);
  if (!m) {
    return { ok: false, error: 'The logo must be a base64 data URI for a PNG, JPEG, WEBP or SVG image.' };
  }
  const bytes = base64Bytes(m[2]);
  if (bytes > MAX_LOGO_BYTES) {
    return { ok: false, error: `The logo must be under ${MAX_LOGO_BYTES / 1024}KB — this one is ${Math.round(bytes / 1024)}KB.` };
  }
  return { ok: true };
}

/** Coerce a stored or posted blob into a well-formed config. The setting is schemaless JSON, so a
 *  value written by an older version can be missing fields; a logo that no longer validates is
 *  dropped rather than served, so a bad write can never poison the public sign-in page. */
export function normalizeBranding(raw: unknown): BrandingConfig {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const companyName = (typeof r.companyName === 'string' ? r.companyName : '').trim().slice(0, MAX_COMPANY_NAME);
  const logo = typeof r.logoDataUri === 'string' ? r.logoDataUri : '';
  return {
    companyName,
    logoDataUri: validateLogoDataUri(logo).ok ? logo : '',
  };
}
