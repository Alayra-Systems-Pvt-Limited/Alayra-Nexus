import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { AiModel } from '../../api';

const update = vi.fn();
vi.mock('../../lib/registry', () => ({ updateModelInRegistry: (m: AiModel) => update(m) }));

const match = vi.fn();
vi.mock('../../lib/catalog', () => ({
  loadPricingCatalog: () => Promise.resolve([]),
  matchPricing: (...a: unknown[]) => match(...a),
}));

import { EditModelDialog } from './EditModelDialog';

const model: AiModel = {
  id: 'openai-gpt-4o', displayName: 'gpt-4o', provider: 'openai', modelString: 'gpt-4o', tier: 'standard', status: 'active',
  priority: 1, capabilities: ['chat'], hasVision: false, hasFIM: false, hasToolCalling: false,
  inputCostPer1M: 0, outputCostPer1M: 0, imagePrice: 0, speechPricePer1MChars: 0, transcriptionPrice: 0,
  audioInputPer1M: 0, audioOutputPer1M: 0, pricingSource: 'unset', contextWindow: 0, maxTokens: 0,
};
const priced: AiModel = { ...model, inputCostPer1M: 2.5, outputCostPer1M: 10, pricingSource: 'manual' };

const save = () => fireEvent.click(screen.getByRole('button', { name: /save model/i }));

beforeEach(() => { update.mockReset(); update.mockResolvedValue(undefined); match.mockReset(); });

describe('EditModelDialog', () => {
  it('shows token pricing for a chat model and saves edits to the registry', async () => {
    render(<EditModelDialog model={priced} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getAllByText('$ / 1M tokens').length).toBeGreaterThan(0); // token pricing visible for chat

    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({ id: 'openai-gpt-4o', capabilities: ['chat'] });
  });

  it('auto-fills pricing from a catalog match and records it as catalog-sourced', async () => {
    match.mockReturnValue({
      entry: { match: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', capabilities: ['chat'], inputCostPer1M: 2.5, outputCostPer1M: 10, contextWindow: 128000, maxTokens: 16384 },
      crossProvider: false,
    });
    render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /auto-fill pricing/i }));
    expect(await screen.findByText(/Filled from “GPT-4o”/)).toBeInTheDocument();

    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({
      inputCostPer1M: 2.5, outputCostPer1M: 10, contextWindow: 128000, pricingSource: 'catalog',
    });
  });

  it('matches the catalog against this pool\'s own provider', () => {
    match.mockReturnValue(null);
    render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /auto-fill pricing/i }));
    expect(match).toHaveBeenCalledWith([], 'gpt-4o', 'openai');
  });

  it('says so when the only match belongs to a different provider', async () => {
    // The number is real but it is someone else's. Filling it silently would put OpenAI's price on
    // an OpenRouter invoice line and look authoritative doing it.
    match.mockReturnValue({
      entry: { match: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', capabilities: ['chat'], inputCostPer1M: 2.5, outputCostPer1M: 10 },
      crossProvider: true,
    });
    render(<EditModelDialog model={{ ...model, provider: 'openrouter' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /auto-fill pricing/i }));
    expect(await screen.findByText(/openai’s price/)).toBeInTheDocument();
    expect(screen.getByText(/may charge\s+a different rate/)).toBeInTheDocument();
  });

  // ── Saving a model nobody has priced ────────────────────────────────────────
  describe('unpriced confirmation', () => {
    it('does not save straight away, and explains the consequence', async () => {
      render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
      save();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/doesn’t publish a price for this model/)).toBeInTheDocument();
      expect(screen.getByText(/reports \$0/)).toBeInTheDocument();
      expect(update).not.toHaveBeenCalled();
    });

    it('saves anyway when the operator insists — warn, never block', async () => {
      render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
      save();
      fireEvent.click(await screen.findByRole('button', { name: /save anyway/i }));

      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(update.mock.calls[0][0]).toMatchObject({ pricingSource: 'unset' });
    });

    it('“Set pricing” dismisses the prompt and leaves the model unsaved', async () => {
      render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
      save();
      fireEvent.click(await screen.findByRole('button', { name: /set pricing/i }));

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(update).not.toHaveBeenCalled();
    });

    it('typing a price clears the prompt and records the figure as the operator\'s own', async () => {
      render(<EditModelDialog model={model} onClose={vi.fn()} onSaved={vi.fn()} />);
      save();
      await screen.findByRole('alert');

      // The Field label carries its hint text too, so the accessible name is "Input price$ / 1M tokens".
      const input = screen.getByLabelText(/Input price/) as HTMLInputElement;
      fireEvent.input(input, { target: { value: '1.5' } });
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

      save();
      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(update.mock.calls[0][0]).toMatchObject({ inputCostPer1M: 1.5, pricingSource: 'manual' });
    });

    it('never prompts for a model that is priced at zero on purpose', async () => {
      // OpenRouter's `:free` models are genuinely free. Warning about them would train the
      // operator to click past the warning that matters.
      const free: AiModel = { ...model, pricingSource: 'harvested' };
      render(<EditModelDialog model={free} onClose={vi.fn()} onSaved={vi.fn()} />);
      save();

      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(update.mock.calls[0][0]).toMatchObject({ pricingSource: 'harvested' });
    });
  });
});
