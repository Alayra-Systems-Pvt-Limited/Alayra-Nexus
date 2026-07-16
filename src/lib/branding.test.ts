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

import { describe, it, expect } from 'vitest';
import { validateLogoDataUri, normalizeBranding, MAX_LOGO_BYTES, MAX_COMPANY_NAME } from './branding';

// A tiny valid payload; `b64of` builds one of a chosen decoded size.
const png = (b64: string) => `data:image/png;base64,${b64}`;
const b64of = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4);

describe('validateLogoDataUri', () => {
  it('accepts the image types the dashboard renders', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) {
      expect(validateLogoDataUri(`data:${mime};base64,AAAA`).ok).toBe(true);
    }
  });

  it('treats an empty string as valid — that is how a logo is removed', () => {
    expect(validateLogoDataUri('').ok).toBe(true);
  });

  it('rejects a non-image data URI, so a payload cannot masquerade as a logo', () => {
    expect(validateLogoDataUri('data:text/html;base64,PHNjcmlwdD4=').ok).toBe(false);
    expect(validateLogoDataUri('data:application/javascript;base64,YWxlcnQoMSk=').ok).toBe(false);
  });

  it('rejects a remote URL: the logo is served from our own origin, never fetched', () => {
    // A URL here would reintroduce exactly the CDN dependency this gateway removed, and would leak
    // a request to a third party on every load of a public sign-in page.
    expect(validateLogoDataUri('https://evil.example.com/logo.png').ok).toBe(false);
    expect(validateLogoDataUri('//evil.example.com/logo.png').ok).toBe(false);
  });

  it('rejects a data URI that is not base64 or carries junk', () => {
    expect(validateLogoDataUri('data:image/png,notbase64').ok).toBe(false);
    expect(validateLogoDataUri('data:image/png;base64,not valid!!').ok).toBe(false);
  });

  it('accepts a logo at the size cap and rejects one over it, naming the actual size', () => {
    expect(validateLogoDataUri(png(b64of(MAX_LOGO_BYTES - 32))).ok).toBe(true);

    const tooBig = validateLogoDataUri(png(b64of(MAX_LOGO_BYTES + 4096)));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/under 64KB/);
  });
});

describe('normalizeBranding', () => {
  it('defaults a missing or malformed blob to no branding', () => {
    expect(normalizeBranding(null)).toEqual({ companyName: '', logoDataUri: '' });
    expect(normalizeBranding('nonsense')).toEqual({ companyName: '', logoDataUri: '' });
    expect(normalizeBranding({ companyName: 42 })).toEqual({ companyName: '', logoDataUri: '' });
  });

  it('trims and caps the company name', () => {
    expect(normalizeBranding({ companyName: '  Acme Corp  ' }).companyName).toBe('Acme Corp');
    expect(normalizeBranding({ companyName: 'x'.repeat(200) }).companyName).toHaveLength(MAX_COMPANY_NAME);
  });

  it('drops a logo that no longer validates rather than serving it', () => {
    // The public sign-in page reads this; a bad value written by an older version (or by hand)
    // must degrade to the product's own mark, not be handed to a browser.
    expect(normalizeBranding({ companyName: 'Acme', logoDataUri: 'javascript:alert(1)' })).toEqual({
      companyName: 'Acme', logoDataUri: '',
    });
  });

  it('keeps a valid logo intact', () => {
    const logo = png('AAAA');
    expect(normalizeBranding({ companyName: 'Acme', logoDataUri: logo })).toEqual({
      companyName: 'Acme', logoDataUri: logo,
    });
  });
});
