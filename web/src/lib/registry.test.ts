import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addModelsToRegistry, removeModelFromRegistry } from './registry';
import type { AiModel } from '../api';

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock('../api', () => ({
  GET: (p: string) => get(p),
  PUT: (p: string, b?: unknown) => put(p, b),
  DEL: (p: string) => del(p),
}));

// A stored registry entry with the operator-owned fields filled in, so tests can prove the merge
// never touches them.
const stored = (over: Partial<AiModel>): AiModel => ({
  id: 'openrouter-claude', displayName: 'My Claude', provider: 'openrouter', modelString: 'anthropic/claude',
  tier: 'premium', status: 'active', priority: 5, capabilities: ['chat', 'vision'],
  hasVision: true, hasFIM: false, hasToolCalling: true,
  inputCostPer1M: 3, outputCostPer1M: 15,
  imagePrice: 0, speechPricePer1MChars: 0, transcriptionPrice: 0, audioInputPer1M: 0, audioOutputPer1M: 0,
  contextWindow: 200000, maxTokens: 8192,
  ...over,
});

beforeEach(() => {
  get.mockReset(); put.mockReset(); del.mockReset();
  put.mockResolvedValue({});
  del.mockResolvedValue({ success: true });
});

describe('removeModelFromRegistry', () => {
  it('deletes through the dedicated endpoint, so the audit reads as a delete', async () => {
    // It used to GET the registry and PUT it back minus one entry, which the audit trail recorded
    // as `models.update` — a deletion that looked like an edit.
    await removeModelFromRegistry('openrouter-gpt-4o');
    expect(del).toHaveBeenCalledWith('/admin/models/openrouter-gpt-4o');
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('encodes an id containing slashes', async () => {
    await removeModelFromRegistry('a/b');
    expect(del).toHaveBeenCalledWith('/admin/models/a%2Fb');
  });
});

describe('addModelsToRegistry', () => {
  it('carries harvested pricing, name, and context into brand-new entries', async () => {
    get.mockResolvedValue({ models: [] });
    const res = await addModelsToRegistry('openrouter', 'standard', [
      { modelString: 'meta/llama-3', displayName: 'Llama 3', inputCostPer1M: 0.5, outputCostPer1M: 1.5, contextWindow: 131072 },
    ]);
    expect(res).toEqual({ added: 1, updated: 0 });
    const payload = put.mock.calls[0][1] as { models: Partial<AiModel>[] };
    expect(payload.models[0]).toMatchObject({
      id: 'openrouter-meta-llama-3', provider: 'openrouter', modelString: 'meta/llama-3',
      displayName: 'Llama 3', tier: 'standard', status: 'active', capabilities: ['chat'],
      inputCostPer1M: 0.5, outputCostPer1M: 1.5, contextWindow: 131072,
    });
  });

  it('refreshes ONLY pricing/context on an existing entry, preserving operator-owned fields', async () => {
    get.mockResolvedValue({ models: [stored({})] });
    const res = await addModelsToRegistry('openrouter', 'fast', [
      { modelString: 'anthropic/claude', displayName: 'Fetched Name', inputCostPer1M: 2.5, outputCostPer1M: 10, contextWindow: 128000 },
    ]);
    expect(res).toEqual({ added: 0, updated: 1 });
    const sent = (put.mock.calls[0][1] as { models: AiModel[] }).models[0];
    expect(sent.inputCostPer1M).toBe(2.5);
    expect(sent.outputCostPer1M).toBe(10);
    expect(sent.contextWindow).toBe(128000);
    // Operator-owned fields untouched — including the tier the dialog happened to pass.
    expect(sent.tier).toBe('premium');
    expect(sent.displayName).toBe('My Claude');
    expect(sent.capabilities).toEqual(['chat', 'vision']);
  });

  it('never lets an unpriced fetch zero out stored pricing', async () => {
    get.mockResolvedValue({ models: [stored({})] });
    const res = await addModelsToRegistry('openrouter', 'premium', [
      { modelString: 'anthropic/claude' }, // plain OpenAI-style fetch: no pricing at all
    ]);
    expect(res).toEqual({ added: 0, updated: 0 });
    expect(put).not.toHaveBeenCalled();
  });

  it('is a no-op when values are identical to what is stored', async () => {
    get.mockResolvedValue({ models: [stored({})] });
    const res = await addModelsToRegistry('openrouter', 'premium', [
      { modelString: 'anthropic/claude', inputCostPer1M: 3, outputCostPer1M: 15, contextWindow: 200000 },
    ]);
    expect(res).toEqual({ added: 0, updated: 0 });
    expect(put).not.toHaveBeenCalled();
  });

  it('suffixes a colliding sanitized id instead of overwriting', async () => {
    // A DIFFERENT provider already owns the id this sanitization would produce.
    get.mockResolvedValue({ models: [stored({ id: 'openrouter-x', provider: 'other', modelString: 'x' })] });
    await addModelsToRegistry('openrouter', 'standard', [{ modelString: 'x' }]);
    const payload = put.mock.calls[0][1] as { models: Partial<AiModel>[] };
    expect(payload.models.at(-1)!.id).toBe('openrouter-x-2');
  });
});
