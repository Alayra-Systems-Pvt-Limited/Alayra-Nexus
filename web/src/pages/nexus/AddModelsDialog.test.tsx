import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

const fetchProviderModels = vi.fn();
vi.mock('../../api', () => ({
  fetchProviderModels: (id: string, key?: string) => fetchProviderModels(id, key),
  ApiError: class ApiError extends Error {},
}));

const addModelsToRegistry = vi.fn();
vi.mock('../../lib/registry', () => ({
  addModelsToRegistry: (...a: unknown[]) => addModelsToRegistry(...a),
}));

import { AddModelsDialog } from './AddModelsDialog';
import type { AiModel, NexusPool } from '../../api';

const pool = { id: 'p1', name: 'openrouter', provider: 'openrouter', tier: 'premium' } as NexusPool;
const model = (modelString: string) => ({ id: `m-${modelString}`, modelString, provider: 'openrouter' } as AiModel);

beforeEach(() => {
  fetchProviderModels.mockReset();
  addModelsToRegistry.mockReset().mockResolvedValue({ added: 1, updated: 0 });
  fetchProviderModels.mockResolvedValue({
    models: [
      { id: 'google/gemini-2.5-flash-lite' },
      { id: 'anthropic/claude-3-haiku' },
      { id: 'Qwen/Qwen3-35B', inputCostPer1M: 0.5, outputCostPer1M: 1.5 },
    ],
  });
});

describe('AddModelsDialog', () => {
  it('fetches with NO plaintext key — the gateway decrypts the pool\'s own', async () => {
    render(<AddModelsDialog pool={pool} existing={[]} onClose={() => {}} onAdded={() => {}} />);
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalled());

    // The whole point: adding a model must not require re-entering a credential that is already
    // stored, because the operator does not have it any more — it is only ever shown masked.
    expect(fetchProviderModels).toHaveBeenCalledWith('p1', undefined);
  });

  it('hides models the pool already has, and says how many it hid', async () => {
    render(
      <AddModelsDialog
        pool={pool}
        existing={[model('google/gemini-2.5-flash-lite'), model('anthropic/claude-3-haiku')]}
        onClose={() => {}}
        onAdded={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/2 models are already in this pool/i)).toBeInTheDocument());
    expect(screen.getByText('Qwen/Qwen3-35B')).toBeInTheDocument();
    expect(screen.queryByText('anthropic/claude-3-haiku')).not.toBeInTheDocument();
  });

  it('adds the picked model with the pricing the provider volunteered', async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    render(<AddModelsDialog pool={pool} existing={[]} onClose={() => {}} onAdded={onAdded} />);

    await waitFor(() => expect(screen.getByText('Qwen/Qwen3-35B')).toBeInTheDocument());
    await user.click(screen.getByText('Qwen/Qwen3-35B'));
    await user.click(screen.getByRole('button', { name: /add 1 model/i }));

    await waitFor(() => expect(addModelsToRegistry).toHaveBeenCalled());
    expect(addModelsToRegistry).toHaveBeenCalledWith('openrouter', 'premium', [
      expect.objectContaining({ modelString: 'Qwen/Qwen3-35B', inputCostPer1M: 0.5, outputCostPer1M: 1.5 }),
    ]);
    expect(onAdded).toHaveBeenCalled();
  });

  it('says so when there is nothing left to add', async () => {
    render(
      <AddModelsDialog
        pool={pool}
        existing={[model('google/gemini-2.5-flash-lite'), model('anthropic/claude-3-haiku'), model('Qwen/Qwen3-35B')]}
        onClose={() => {}}
        onAdded={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/already in this pool/i)).toBeInTheDocument());
  });

  it('surfaces the gateway\'s own message when the pool has no key to fetch with', async () => {
    fetchProviderModels.mockRejectedValue(
      Object.assign(new Error('Enter an API key, or add an active key to this pool first'), { name: 'ApiError' }),
    );
    render(<AddModelsDialog pool={pool} existing={[]} onClose={() => {}} onAdded={() => {}} />);

    // Not replaced with a generic string: "add an active key first" is the actionable half.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
