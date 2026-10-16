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

// With NEXUS_TPM_ESTIMATE=fast, routing may turn a request's estimated reservation into the exact
// count while it walks the keys (see TokenReserve in lib/tokenizer.ts). Whatever it settled on is
// what the key's window holds, so it is what a refund must give back. These tests pin that the
// proxy reads the reservation AFTER routing, not the estimate it started with.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The mode is read once, when the modules load, so it is set before any import.
vi.hoisted(() => { process.env.NEXUS_TPM_ESTIMATE = 'fast'; });

vi.mock('../cache.service',      () => ({ getCacheConfig: vi.fn(async () => ({ enabled: false, ttlSeconds: 0 })) }));
vi.mock('../byok.service',       () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('../guardrails.service', () => ({ getGuardrailConfig: vi.fn(async () => ({ enabled: false, compiled: [], bufferedSafe: false })) }));
vi.mock('../ssrf.service',       () => ({ getSsrfPolicy: vi.fn(async () => ({ allowPrivate: true, allowList: new Set<string>() })) }));
vi.mock('../budget.service',     () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true, downgrade: false, spendUsd: 0, retryAfterSeconds: 0 })) }));
vi.mock('../token.service',      () => ({ recordTokenUsage: vi.fn(async () => {}), recordOutcome: vi.fn(async () => {}) }));

const discoverBestPool = vi.fn();
vi.mock('../nexus.service', () => ({
  discoverBestPool: (...a: unknown[]) => discoverBestPool(...a),
  getNextCooldownSeconds: vi.fn(async () => 30),
  reportSuccess:      vi.fn(async () => {}), reportServerFailure: vi.fn(async () => {}),
  reportRateLimit:    vi.fn(async () => {}), reportAuthFailure:   vi.fn(async () => {}),
  reportTierExhausted: vi.fn(async () => {}),
}));

vi.mock('../../lib/sticky', () => ({ sessionHash: () => 'session-1', setStickyKeyId: vi.fn(async () => {}) }));
const reconcileTpm = vi.fn(async () => {});
vi.mock('../../lib/admission', () => ({ reconcileTpm: (...a: unknown[]) => reconcileTpm(...(a as [])) }));

// The provider is unreachable, so the proxy refunds the whole reservation and stops there.
vi.mock('../../lib/safeFetch', () => ({ safeFetch: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) }));
vi.mock('../modelCatalog.service', async (o) => ({
  ...(await o<typeof import('../modelCatalog.service')>()),
  noCapacityMessage: vi.fn(async () => 'No capacity.'),
}));

import { handleProxy } from '../completionsProxy.service';
import { coreStores } from '../../core/stores';
import { countMessageTokens, estimateMessageTokens, type TokenReserve } from '../../lib/tokenizer';

const ROUTE = {
  keyId: 'key-1', decryptedKey: 'sk-test', keyMask: '●●●●1234',
  baseUrl: 'https://api.openai.com/v1',
  modelString: 'gpt-4o', modelId: 'm-1', providerSlug: 'openai', tier: 'premium',
  authHeader: 'Authorization', authPrefix: 'Bearer', extraHeaders: null,
  wasDowngrade: false, isProbe: false, sticky: false, byok: false,
};

const messages = [{ role: 'user', content: 'Count every token of this prompt before routing it, please. '.repeat(40) }];
const MAX_TOKENS = 100;

function reply() {
  const r = { header: () => r, code: () => r, send: () => r, hijack() {}, raw: { writeHead() {}, write() {}, end() {} } };
  return r;
}

beforeAll(async () => { await coreStores(); });
afterAll(() => { delete process.env.NEXUS_TPM_ESTIMATE; });
beforeEach(() => { vi.clearAllMocks(); });

describe('the reservation a refund gives back', () => {
  it('starts as the estimate, which is above the exact count', () => {
    expect(estimateMessageTokens(messages)).toBeGreaterThan(countMessageTokens(messages));
  });

  it('is the estimate when routing kept it', async () => {
    discoverBestPool.mockImplementation(async () => ROUTE);
    await handleProxy({ messages, max_tokens: MAX_TOKENS } as never, reply() as never, undefined, {}, undefined);
    expect(reconcileTpm).toHaveBeenCalledWith('key-1', estimateMessageTokens(messages) + MAX_TOKENS, 0);
  });

  it('is the exact count when routing made it exact', async () => {
    discoverBestPool.mockImplementation(async (reserve: TokenReserve) => { reserve.makeExact(); return ROUTE; });
    await handleProxy({ messages, max_tokens: MAX_TOKENS } as never, reply() as never, undefined, {}, undefined);
    expect(reconcileTpm).toHaveBeenCalledWith('key-1', countMessageTokens(messages) + MAX_TOKENS, 0);
  });
});
