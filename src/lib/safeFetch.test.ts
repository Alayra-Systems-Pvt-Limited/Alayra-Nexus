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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeFetch } from './safeFetch';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const response = (status: number, location?: string) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location ?? null : null) },
});

describe('safeFetch — the redirect half of the SSRF guard', () => {
  it('always sends redirect: manual, whatever the caller passed', async () => {
    fetchMock.mockResolvedValue(response(200));
    await safeFetch('https://api.example.com/models', { method: 'POST', redirect: 'follow' } as RequestInit);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/models',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }));
  });

  it('passes non-redirect responses through untouched, including errors', async () => {
    fetchMock.mockResolvedValue(response(500));
    const res = await safeFetch('https://api.example.com/x');
    expect(res.status).toBe(500); // the caller's own error handling stays in charge
  });

  it.each([301, 302, 303, 307, 308])('refuses to follow a %i, naming the target', async (status) => {
    // The attack this closes: a vetted "provider" answering with a redirect into cloud
    // metadata / loopback — the guard checked the first URL, the redirect goes anywhere.
    fetchMock.mockResolvedValue(response(status, 'http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('https://api.evil-provider.com/models')).rejects.toThrow(/redirect to http:\/\/169\.254\.169\.254.*SSRF/s);
  });

  it('still refuses a redirect that hides its Location', async () => {
    fetchMock.mockResolvedValue(response(302));
    await expect(safeFetch('https://api.example.com/x')).rejects.toThrow(/no Location header/);
  });
});
