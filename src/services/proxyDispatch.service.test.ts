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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

const h = vi.hoisted(() => ({
  route: null as null | Record<string, unknown>,
  fetchImpl: null as null | ((url: string, init: Record<string, unknown>) => Promise<unknown>),
  // What model resolution returns for these tests. Resolution itself reads the registry and
  // the pool table, and is tested against those in modelCatalog.service.test.ts; here the
  // subject is dispatch, so the answer is injected rather than derived.
  resolution: { kind: 'auto' } as Record<string, unknown>,
}));

vi.mock('./nexus.service', () => ({
  discoverBestPool:    vi.fn(async () => h.route),
  getNextCooldownSeconds: vi.fn(async () => 42),
  reportSuccess:       vi.fn(async () => {}),
  reportServerFailure: vi.fn(async () => {}),
  reportRateLimit:     vi.fn(async () => {}),
  reportAuthFailure:   vi.fn(async () => {}),
  reportTierExhausted: vi.fn(async () => {}),
}));
vi.mock('./token.service',  () => ({ recordTokenUsage: vi.fn(async () => {}), recordOutcome: vi.fn(async () => {}) }));
vi.mock('../lib/admission', () => ({ reconcileTpm: vi.fn(async () => {}) }));
vi.mock('../lib/url',       () => ({ assertSafeUrl: vi.fn(() => {}), stripTrailingSlash: (s: string) => s.replace(/\/$/, '') }));
vi.mock('./ssrf.service',   () => ({ getSsrfPolicy: vi.fn(async () => ({})) }));
vi.mock('./byok.service',   () => ({ resolveRequestScope: vi.fn(async () => ({ ownerTeamId: null, fallbackToShared: true, namespace: 'shared' })) }));
vi.mock('./budget.service', () => ({ checkTeamBudget: vi.fn(async () => ({ allowed: true })) }));
vi.mock('./modelCatalog.service', () => ({
  resolveRequestedModel: vi.fn(async () => h.resolution),
  unknownModelError: (r: { requested: string; available: string[] }) => ({ error: `Unknown model "${r.requested}".`, available: r.available }),
}));

import { dispatchProxy, embeddingReserve, completionReserve, extractTokenUsage, imageReserve, imageQuantity, speechReserve, speechCharacters } from './proxyDispatch.service';
import * as nexus from './nexus.service';
import { recordTokenUsage } from './token.service';

function fakeReply() {
  const state = { status: 200, sent: undefined as unknown, headers: {} as Record<string, string> };
  const reply = {
    code(c: number) { state.status = c; return reply; },
    header(k: string, v: string) { state.headers[k] = v; return reply; },
    send(b: unknown) { state.sent = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const okRoute = {
  keyId: 'k1', decryptedKey: 'sk-real', baseUrl: 'https://api.example.com/v1', modelString: 'text-embed-3',
  modelId: 'embed', providerSlug: 'openai', tier: 'standard', authHeader: 'Authorization', authPrefix: 'Bearer',
  wasDowngrade: false, isProbe: false, sticky: false, byok: false,
};

let lastFetch: { url: string; init: Record<string, unknown> } | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  h.route = { ...okRoute };
  // And the fetch stub, which was the one piece of shared state this hook did NOT reset.
  //
  // Ten tests below assign h.fetchImpl — 401s, 502s, 429s, image payloads — and none of them put it
  // back. Every later test therefore inherited whatever the previous one left, so a test that sets
  // no fetchImpl was not testing the default response at all; it was testing its predecessor's.
  // "forwards to the provider path" is exactly such a test, and it passed only because the test
  // declared above it happens to leave a 200 behind. Reorder the file, or insert a case between
  // them, and it starts asserting 200 against a leftover 401.
  //
  // Found by running the suite with the test order shuffled (npm run test:hunt -- --shuffle-tests),
  // where it failed as 401 and as 504 on different seeds — the giveaway, since a genuinely slow or
  // racy test does not fail with a DIFFERENT wrong answer each time. It fails in ~20ms, so nothing
  // about it was ever a timing problem.
  h.fetchImpl = null;
  // Same reason as the fetch stub above: the model-pinning cases below assign this, and a
  // leaked `pinned` would silently change the routing arguments every later test asserts.
  h.resolution = { kind: 'auto' };
  lastFetch = null;
  globalThis.fetch = vi.fn(async (url: string, init: Record<string, unknown>) => {
    lastFetch = { url, init };
    return (h.fetchImpl ? h.fetchImpl(url, init) : { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 7 } }) }) as unknown;
  }) as unknown as typeof fetch;
});

describe('pure helpers', () => {
  it('embeddingReserve counts a string or array input', () => {
    expect(embeddingReserve({ input: 'hello world' })).toBeGreaterThan(0);
    expect(embeddingReserve({ input: ['a', 'b'] })).toBeGreaterThan(0);
  });
  it('completionReserve adds the output cap to the prompt', () => {
    expect(completionReserve({ prompt: 'x', max_tokens: 100 })).toBeGreaterThan(100);
  });
  it('extractTokenUsage reads embeddings (input only) and completions (both)', () => {
    expect(extractTokenUsage({ usage: { prompt_tokens: 5 } })).toEqual({ input: 5, output: 0 });
    expect(extractTokenUsage({ usage: { prompt_tokens: 5, completion_tokens: 9 } })).toEqual({ input: 5, output: 9 });
    expect(extractTokenUsage({})).toEqual({ input: 0, output: 0 });
  });
  it('imageReserve claims a nominal slot from the prompt', () => {
    expect(imageReserve({ prompt: 'a cat' })).toBeGreaterThan(0);
    expect(imageReserve({})).toBe(1);
  });
  it('imageQuantity counts returned images, or undefined when absent', () => {
    expect(imageQuantity({ data: [{ url: 'a' }, { url: 'b' }] })).toBe(2);
    expect(imageQuantity({})).toBeUndefined();
  });
  it('speech helpers reserve from and count the input text', () => {
    expect(speechReserve({ input: 'hello there' })).toBeGreaterThan(0);
    expect(speechReserve({})).toBe(1);
    expect(speechCharacters({ input: 'hello' })).toBe(5);
    expect(speechCharacters({})).toBe(0);
  });
});

describe('dispatchProxy — binary (text-to-speech, Phase 6.3c)', () => {
  const speechOpts = {
    capability: 'speech' as const, upstreamPath: '/audio/speech', reserveTokens: 4,
    responseMode: 'binary' as const,
    billing: { unit: 'character', quantityFromRequest: speechCharacters },
  };

  it('streams the audio bytes back with the upstream Content-Type and bills per character', async () => {
    const audio = Buffer.from('ID3-fake-mp3-bytes');
    h.fetchImpl = async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
    });
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hello', voice: 'alloy' }, reply, speechOpts);

    expect(state.status).toBe(200);
    expect(state.headers['Content-Type']).toBe('audio/mpeg');
    expect(Buffer.isBuffer(state.sent)).toBe(true);
    expect((state.sent as Buffer).toString()).toBe('ID3-fake-mp3-bytes');
    expect(recordTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ unit: 'character', quantity: 5, inputTokens: 0 }));
  });
});

describe('dispatchProxy — multipart request (transcription, Phase 6.3d)', () => {
  it('forwards the caller-built form with the routed model and no JSON Content-Type, billing once', async () => {
    const transcript = Buffer.from('{"text":"hello world"}');
    h.fetchImpl = async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => transcript.buffer.slice(transcript.byteOffset, transcript.byteOffset + transcript.byteLength),
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    });
    const built = new FormData();
    let modelPassedToBuilder = '';
    const { reply, state } = fakeReply();
    await dispatchProxy({}, reply, {
      capability: 'transcription', upstreamPath: '/audio/transcriptions', reserveTokens: 1,
      responseMode: 'binary',
      requestBuild: (model: string) => { modelPassedToBuilder = model; built.append('model', model); return built; },
      billing: { unit: 'transcription', quantityFromRequest: () => 1 },
    });

    expect(modelPassedToBuilder).toBe('text-embed-3');           // routing chose the model, not the client
    expect(lastFetch!.init.body).toBe(built);                    // the caller's form is forwarded as-is
    expect((lastFetch!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined(); // fetch sets the multipart boundary
    expect(state.status).toBe(200);
    expect(recordTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ unit: 'transcription', quantity: 1, inputTokens: 0 }));
  });
});

describe('dispatchProxy — per-image billing (Phase 6.3b)', () => {
  const imageOpts = {
    capability: 'image' as const, upstreamPath: '/images/generations', reserveTokens: 5,
    billing: { unit: 'image', quantityFromResponse: imageQuantity, quantityFromRequest: (b: Record<string, unknown>) => (typeof b.n === 'number' ? b.n : 1) },
  };

  it('bills the returned image count as unit "image", not tokens', async () => {
    h.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ created: 1, data: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }) });
    const { reply, state } = fakeReply();
    await dispatchProxy({ prompt: 'a fox', n: 3 }, reply, imageOpts);

    expect(state.status).toBe(200);
    expect(recordTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ unit: 'image', quantity: 3, inputTokens: 0, outputTokens: 0 }));
  });

  it('falls back to the requested n when the response omits data[]', async () => {
    h.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ created: 1 }) });
    const { reply } = fakeReply();
    await dispatchProxy({ prompt: 'a fox', n: 2 }, reply, imageOpts);

    expect(recordTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ unit: 'image', quantity: 2 }));
  });
});

describe('dispatchProxy — success', () => {
  it('forwards to the provider path with the routed model, dropping any stream flag', async () => {
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi', model: 'auto', stream: true }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });

    expect(lastFetch!.url).toBe('https://api.example.com/v1/embeddings');
    const body = JSON.parse(lastFetch!.init.body as string);
    expect(body.model).toBe('text-embed-3');   // routed model, not the caller's "auto"
    expect(body.stream).toBeUndefined();        // one-shot
    expect(state.status).toBe(200);
    expect(state.headers['X-Nexus-Model']).toBe('text-embed-3');
  });

  it('reports success and records usage attributed to the registry model id', async () => {
    const { reply } = fakeReply();
    h.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 11, completion_tokens: 4 } }) });
    await dispatchProxy({ input: 'hi' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3, teamKeyId: 'tk' });

    expect(nexus.reportSuccess).toHaveBeenCalledWith('k1', false);
    expect(recordTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'embed', inputTokens: 11, outputTokens: 4, nexusTeamKeyId: 'tk' }));
  });
});

describe('dispatchProxy — failures feed the breaker', () => {
  it('returns 503 with a capability-specific message when no model is available', async () => {
    h.route = null;
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });
    expect(state.status).toBe(503);
    expect(String((state.sent as Record<string, unknown>).error)).toContain('embedding');
  });

  it('cools the key on a 429', async () => {
    h.fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });
    expect(nexus.reportRateLimit).toHaveBeenCalledWith('k1');
    expect(state.status).toBe(429);
  });

  it('strikes the breaker on a 5xx', async () => {
    h.fetchImpl = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });
    expect(nexus.reportServerFailure).toHaveBeenCalledWith('k1', false);
    expect(state.status).toBe(502);
  });

  it('bans on repeated auth failure signal (401)', async () => {
    h.fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'nope' });
    const { reply } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });
    expect(nexus.reportAuthFailure).toHaveBeenCalledWith('k1');
  });

  it('does not call the provider when the team budget is exhausted', async () => {
    const budget = await import('./budget.service');
    vi.mocked(budget.checkTeamBudget).mockResolvedValueOnce({ allowed: false, spendUsd: 10, retryAfterSeconds: 60 } as never);
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, {
      capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3,
      team: { id: 't1', budgetUsd: 5, budgetPeriod: 'monthly' },
    });
    expect(state.status).toBe(429);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('pins an over-budget "downgrade" team to the fast tier instead of blocking it (Phase 7.10)', async () => {
    h.route = okRoute;
    h.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 5, completion_tokens: 2 } }) });
    const budget = await import('./budget.service');
    vi.mocked(budget.checkTeamBudget).mockResolvedValueOnce({ allowed: true, downgrade: true, spendUsd: 12, retryAfterSeconds: 60 } as never);
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi' }, reply, {
      capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3,
      team: { id: 't1', budgetUsd: 10, budgetPeriod: 'monthly', overBudgetAction: 'downgrade', assignedTier: 'premium' },
    });
    expect(state.status).toBe(200); // served, not blocked
    // The team prefers "premium", but being over budget forces the cheapest tier for routing.
    expect(nexus.discoverBestPool).toHaveBeenLastCalledWith(3, null, expect.anything(), 'embedding', null, 'fast', null);
  });
});

describe('dispatchProxy — the caller may name a model', () => {
  // These endpoints used to discard `model` outright, so an operator with several embedding
  // models had no way to reach a particular one. Resolution is shared with the chat path.
  it('routes to the model the caller pinned', async () => {
    h.resolution = { kind: 'pinned', model: { id: 'embed-large' } };
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi', model: 'embed-large' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });

    expect(state.status).toBe(200);
    expect(nexus.discoverBestPool).toHaveBeenLastCalledWith(3, null, expect.anything(), 'embedding', null, null, 'embed-large');
  });

  it('400s a model this gateway cannot serve, rather than quietly serving another', async () => {
    h.resolution = { kind: 'unknown', requested: 'not-a-model', available: ['alayra-nexus-1', 'embed'] };
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi', model: 'not-a-model' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });

    expect(state.status).toBe(400);
    expect((state.sent as { error: string }).error).toContain('not-a-model');
    expect(nexus.discoverBestPool).not.toHaveBeenCalled();
  });

  it('names the pinned model in the 503 when its provider has no headroom', async () => {
    h.resolution = { kind: 'pinned', model: { id: 'embed-large' } };
    h.route = null;
    const { reply, state } = fakeReply();
    await dispatchProxy({ input: 'hi', model: 'embed-large' }, reply, { capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: 3 });

    expect(state.status).toBe(503);
    expect((state.sent as { error: string }).error).toContain('embed-large');
  });
});
