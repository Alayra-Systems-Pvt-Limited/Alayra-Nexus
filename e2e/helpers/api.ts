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

// Thin wire client for the API suite. Deliberately NOT the dashboard's api.ts and
// deliberately dumber than it: no header inference, no error prettying. A test must
// control exactly what goes on the wire — including the ability to send the wrong
// thing on purpose — and see exactly what came back.

export interface WireResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export class Gateway {
  constructor(private baseURL: string) {}

  async send<T = Record<string, unknown>>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<WireResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    const text = await res.text();
    let body: T;
    try { body = JSON.parse(text) as T; } catch { body = { raw: text } as T; }
    return { status: res.status, body };
  }

  get<T = Record<string, unknown>>(path: string, token?: string) {
    return this.send<T>('GET', path, { token });
  }

  post<T = Record<string, unknown>>(path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return this.send<T>('POST', path, opts);
  }

  /** Sign in with email + password and hand back the session token. Throws if refused. */
  async login(email: string, password: string, code?: string): Promise<string> {
    const res = await this.send<{ token?: string; error?: string }>('POST', '/admin/login', {
      body: { email, password, ...(code ? { code } : {}) },
    });
    if (res.status !== 200 || !res.body.token) {
      throw new Error(`login as ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.token;
  }
}
