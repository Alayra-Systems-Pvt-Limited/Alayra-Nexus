/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// ── The token kinds reach the usage row, on both delivery paths ───────────────────────────────
//
// lib/usageDetail.test.ts proves each format is READ correctly. This proves the proxy hands what it
// read to the usage row, streamed and not, and that the caller still receives the provider's usage
// object exactly as the provider sent it: recording more must not change what is relayed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fixtures from '../lib/__fixtures__/provider-usage.json';

vi.mock('./cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 0 })) }));
vi.mock('./byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('./ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('./budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));

const recordTokenUsage = vi.fn(async () => {});
vi.mock('./token.service', () => ({
  recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...(a as [])),
  recordOutcome:    vi.fn(async () => {}),
}));
vi.mock('./nexus.service', () => ({
  discoverBestPool: vi.fn(async () => ({
    keyId: 'key-1', decryptedKey: 'sk-test', keyMask: '●●●●1234', baseUrl: 'https://api.example.test/v1',
    modelString: 'm', modelId: 'm-1', providerSlug: 'custom', tier: 'premium',
    authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
    wasDowngrade: false, isProbe: false, sticky: false, byok: false,
  })),
  getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess: vi.fn(async () => {}), reportServerFailure: vi.fn(async () => {}),
  reportRateLimit: vi.fn(async () => {}), reportAuthFailure: vi.fn(async () => {}), reportTierExhausted: vi.fn(async () => {}),
}));
vi.mock('../lib/sticky',    () => ({ sessionHash: () => 'session-1', setStickyKeyId: vi.fn(async () => {}) }));
vi.mock('../lib/admission', () => ({ reconcileTpm: vi.fn(async () => {}) }));
const safeFetch = vi.fn();
vi.mock('../lib/safeFetch', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));

import { handleProxy } from './completionsProxy.service';

interface Format {
  name: string;
  nonStream: Record<string, unknown>;
  stream: string;
  expect: { input: number | null; output: number | null; detail: Record<string, number> };
}
const FORMATS = (fixtures as { formats: Format[] }).formats.map((f) => [f.name, f] as const);
const messages = [{ role: 'user', content: 'hello' }];

/** A reply that keeps what the proxy sent, streamed or whole. */
function sink() {
  const state = { sent: undefined as unknown, written: '' };
  const r = {
    header: () => r, code: () => r, send: (p: unknown) => { state.sent = p; return r; }, hijack() {},
    raw: { writeHead() {}, write(c: string | Uint8Array) { state.written += typeof c === 'string' ? c : new TextDecoder().decode(c); }, end() {} },
  };
  return { reply: r as never, state };
}

/** The upstream stream in 11-byte reads, so frames split across chunks as they do on a socket. */
function streamingUpstream(text: string) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return { ok: true, status: 200, body: { getReader: () => ({
    read: async () => (at < bytes.length ? { done: false, value: bytes.slice(at, (at += 11)) } : { done: true, value: undefined }),
  }) } };
}

type Row = { inputTokens: number; outputTokens: number; detail?: Record<string, number> };
const row = () => recordTokenUsage.mock.calls[0]?.[0] as unknown as Row;

beforeEach(() => { vi.clearAllMocks(); });

describe.each(FORMATS)('%s', (_name, f) => {
  it('non-stream: the row carries the reported kinds, and the caller gets the usage object untouched', async () => {
    const answer = structuredClone(f.nonStream);
    safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => answer });
    const { reply, state } = sink();
    await handleProxy({ messages } as never, reply);

    expect(row().detail).toEqual(f.expect.detail);
    if (f.expect.input !== null) expect([row().inputTokens, row().outputTokens]).toEqual([f.expect.input, f.expect.output]);
    expect(state.sent).toEqual(f.nonStream);
  });

  it('stream: the row carries the same kinds, and the bytes are relayed unchanged', async () => {
    safeFetch.mockResolvedValue(streamingUpstream(f.stream));
    const { reply, state } = sink();
    await handleProxy({ messages, stream: true } as never, reply);

    expect(row().detail).toEqual(f.expect.detail);
    if (f.expect.input !== null) expect([row().inputTokens, row().outputTokens]).toEqual([f.expect.input, f.expect.output]);
    expect(state.written).toBe(f.stream);
  });
});
