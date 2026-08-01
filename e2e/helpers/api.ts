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

/** A reply kept as bytes rather than parsed. What an export answers with. */
export interface BinaryResponse {
  status: number;
  headers: Headers;
  bytes: Buffer;
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

  /**
   * POST a JSON body and keep the reply as BYTES.
   *
   * The export route answers with an octet-stream, and `send()` would put a backup file through a
   * UTF-8 decode nobody asked for — every byte above 0x7f replaced, the ciphertext destroyed, and
   * the damage invisible because the result is still a string. A spec that means to re-upload what
   * it downloaded has to hold the real bytes.
   *
   * The headers come back too: an export's `content-disposition` and `cache-control` are part of
   * what the route promises, not incidental.
   */
  async download(path: string, opts: { token?: string; body?: unknown } = {}): Promise<BinaryResponse> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /**
   * POST multipart/form-data: one file part plus text fields.
   *
   * Content-Type is deliberately NOT set here. `fetch` writes it from the FormData, boundary and
   * all; setting it by hand produces a header with no boundary and a body the server cannot parse.
   * That is the same trap the dashboard's own upload documents at `web/src/lib/backupClient.ts`,
   * and a suite that fell into it would be testing a broken client rather than the server.
   */
  async upload<T = Record<string, unknown>>(
    path: string,
    opts: {
      token?: string;
      file?: { bytes: Buffer; filename: string };
      fields?: Record<string, string>;
    },
  ): Promise<WireResponse<T>> {
    const form = new FormData();
    // `new Uint8Array(buf)` rather than the Buffer itself: a Buffer's backing store is typed
    // `ArrayBufferLike`, which includes SharedArrayBuffer and so is not a `BlobPart`. This copies
    // into a plain ArrayBuffer — the bytes are identical, and the alternative is an assertion that
    // silences the compiler without making the claim true.
    if (opts.file) form.append('file', new Blob([new Uint8Array(opts.file.bytes)]), opts.file.filename);
    for (const [name, value] of Object.entries(opts.fields ?? {})) form.append(name, value);

    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    const res = await fetch(`${this.baseURL}${path}`, { method: 'POST', headers, body: form });
    const text = await res.text();
    let body: T;
    try { body = JSON.parse(text) as T; } catch { body = { raw: text } as T; }
    return { status: res.status, body };
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
