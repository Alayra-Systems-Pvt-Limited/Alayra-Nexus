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
import { buildBaseUrl, buildOrigin } from './baseUrl';

describe('buildOrigin', () => {
  it('is the scheme+host with no /v1 suffix', () => {
    expect(buildOrigin({ host: 'localhost:3000' })).toBe('http://localhost:3000');
  });
  it('honours forwarded proto and host behind a proxy — the externally-reachable origin', () => {
    expect(buildOrigin({ host: 'nexus:3000', forwardedProto: 'https', forwardedHost: 'gateway.acme.com' }))
      .toBe('https://gateway.acme.com');
  });
});

describe('buildBaseUrl', () => {
  // The regression: Fastify v5's `request.hostname` strips the port, so the dashboard
  // handed out `http://localhost/v1` and every client failed to connect.
  it('keeps the port', () => {
    expect(buildBaseUrl({ host: 'localhost:3000' })).toBe('http://localhost:3000/v1');
  });

  it('omits a port that was never there', () => {
    expect(buildBaseUrl({ host: 'nexus.example.com' })).toBe('http://nexus.example.com/v1');
  });

  it('prefers the forwarded host and proto behind a reverse proxy', () => {
    expect(buildBaseUrl({
      host: 'nexus:3000',
      forwardedProto: 'https',
      forwardedHost:  'gateway.acme.com',
    })).toBe('https://gateway.acme.com/v1');
  });

  it('takes the first entry when a proxy chain sends a list', () => {
    expect(buildBaseUrl({
      host: 'nexus:3000',
      forwardedProto: 'https, http',
      forwardedHost:  'gateway.acme.com, inner-lb',
    })).toBe('https://gateway.acme.com/v1');
  });

  it('handles a header delivered as an array', () => {
    expect(buildBaseUrl({
      host: 'nexus:3000',
      forwardedProto: ['https'],
      forwardedHost:  ['gateway.acme.com'],
    })).toBe('https://gateway.acme.com/v1');
  });

  it('ignores an empty forwarded header rather than producing "://"', () => {
    expect(buildBaseUrl({ host: 'localhost:3000', forwardedProto: '', forwardedHost: '' }))
      .toBe('http://localhost:3000/v1');
  });

  it('preserves an IPv6 literal with its port', () => {
    expect(buildBaseUrl({ host: '[::1]:3000' })).toBe('http://[::1]:3000/v1');
  });
});
