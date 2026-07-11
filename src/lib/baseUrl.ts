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

// The base URL the dashboard tells you to paste into Cursor, Cline, or an SDK. It has
// to be exactly right: a URL that silently drops its port produces a client that
// cannot connect, with no clue as to why.

export interface BaseUrlSource {
  /** `request.host` — the Host header, *including* the port. */
  host: string;
  forwardedProto?: string | string[];
  forwardedHost?:  string | string[];
}

/** A proxy may send a comma-separated list; the first entry is the original client. */
function firstValue(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  const first = raw?.split(',')[0]?.trim();
  return first || undefined;
}

/**
 * Build the public `/v1` base URL for this deployment.
 *
 * Behind a reverse proxy the `X-Forwarded-*` headers describe how the client reached
 * us, and win. Otherwise the Host header is used verbatim.
 *
 * Use `request.host`, never `request.hostname`: Fastify v5 changed `hostname` to strip
 * the port, so on `localhost:3000` it yields `localhost` and the dashboard hands out
 * `http://localhost/v1` — a base URL that connects to nothing.
 */
export function buildBaseUrl(src: BaseUrlSource): string {
  return `${buildOrigin(src)}/v1`;
}

/**
 * The public origin (`scheme://host[:port]`) for this deployment, using the same
 * reverse-proxy rules as buildBaseUrl. Used to construct absolute callback URLs — an
 * OIDC `redirect_uri` must be the externally-reachable address, not the internal host.
 */
export function buildOrigin(src: BaseUrlSource): string {
  const proto = firstValue(src.forwardedProto) ?? 'http';
  const host  = firstValue(src.forwardedHost)  ?? src.host;
  return `${proto}://${host}`;
}
