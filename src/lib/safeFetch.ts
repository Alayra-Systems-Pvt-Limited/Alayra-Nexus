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

// The one fetch the gateway's outbound requests go through — and the missing half of the SSRF
// guard. assertSafeUrl vets the URL the request STARTS at; fetch's default redirect policy then
// happily follows a 3xx anywhere, so a "provider" answering `302 Location: http://169.254.169.254/`
// would walk the request straight past the guard and into cloud metadata. Redirects are therefore
// refused, not re-vetted: no real provider API redirects an authenticated call, following would
// re-send the Authorization header to wherever Location points, and a re-vetting loop is exactly
// the kind of clever that grows its own bugs.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (REDIRECT_STATUSES.has(res.status)) {
    const target = res.headers.get('location') ?? '(no Location header)';
    throw new Error(
      `Upstream answered with a ${res.status} redirect to ${target} — refusing to follow it ` +
      `(SSRF protection: only the vetted URL may be fetched). Point the configuration at the ` +
      `final address instead.`,
    );
  }
  return res;
}
