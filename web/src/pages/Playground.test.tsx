import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  useApi: vi.fn(),
  runPlayground: vi.fn(),
}));

vi.mock('../hooks/useApi', () => ({ useApi: mocks.useApi }));
vi.mock('../lib/playground', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/playground')>();
  return { ...actual, runPlayground: mocks.runPlayground };
});

import { Playground } from './Playground';

const models = {
  models: [
    {
      id: 'alayra-nexus-1', displayName: 'Alayra Nexus Auto', provider: 'alayra-nexus',
      auto: true, contextWindow: 0, maxTokens: 0,
    },
    {
      id: 'gpt-test', displayName: 'GPT Test', provider: 'openai',
      auto: false, contextWindow: 8192, maxTokens: 2048,
    },
  ],
};

function ready() {
  mocks.useApi.mockReturnValue({ data: models, loading: false, error: null, reload: vi.fn() });
}

describe('Playground', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders the single-chat controls and the prompt privacy promise', () => {
    ready();
    render(<Playground />);

    expect(screen.getByRole('heading', { name: 'Playground' })).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveValue('alayra-nexus-1');
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument();
    expect(screen.getByText('Prompts pass through your gateway and are not stored.')).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('streams one prompt into the conversation and reports the routed model', async () => {
    ready();
    mocks.runPlayground.mockImplementation(async (_input, callbacks) => {
      callbacks.onDelta('Hello');
      callbacks.onDelta(' from Nexus');
      callbacks.onResult({
        response: { status: 200, headers: {}, streamed: true, truncated: false },
        trace: {
          requestedModel: 'alayra-nexus-1', resolution: 'auto', stream: true, cache: 'bypassed',
          timing: { ttfbMs: 42, upstreamMs: 110, totalMs: 125 },
          route: {
            modelString: 'gpt-test', modelId: 'gpt-test', provider: 'openai', tier: 'standard',
            keyId: 'key-1', keyMask: 'masked-test', sticky: false, byok: false, downgraded: false, probe: false,
          },
          usage: { inputTokens: 8, outputTokens: 3, estimatedUsd: 0.0002, savedUsd: 0, priced: true },
          attempts: [{ provider: 'openai', modelString: 'gpt-test', tier: 'standard', keyMask: 'masked-test', status: 200, ttfbMs: 42, outcome: 'success' }],
          outcome: 'success',
        },
      });
    });

    render(<Playground />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'Say hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Say hello')).toBeInTheDocument();
    expect(await screen.findByText('Hello from Nexus')).toBeInTheDocument();
    expect(await screen.findByText(/gpt-test.*routed/)).toBeInTheDocument();
    expect(screen.getByText('Routing details')).toBeInTheDocument();
    expect(screen.getByText('125 ms')).toBeInTheDocument();
    expect(screen.getByText('$0.0002')).toBeInTheDocument();

    expect(mocks.runPlayground).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'alayra-nexus-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
        temperature: 0.7,
        maxTokens: 2048,
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it('sends a system prompt as content parts without UI-only fields', async () => {
    ready();
    mocks.runPlayground.mockResolvedValue(undefined);
    render(<Playground />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'System prompt' }));
    await user.type(screen.getByPlaceholderText('Give the model instructions for this conversation.'), 'Be concise.');
    await user.type(screen.getByLabelText('Message'), 'Explain routing');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(mocks.runPlayground).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Explain routing' }] },
        ],
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });
  it('runs selected models together and isolates a failed comparison lane', async () => {
    ready();
    mocks.runPlayground.mockImplementation(async (input, callbacks) => {
      if (input.model === 'alayra-nexus-1') throw new Error('Auto route unavailable');
      callbacks.onDelta('GPT comparison answer');
      callbacks.onResult({
        response: { status: 200, headers: {}, streamed: true, truncated: false },
        trace: {
          requestedModel: input.model, resolution: 'pinned', stream: true, cache: 'bypassed',
          timing: { totalMs: 90 },
          route: {
            modelString: input.model, modelId: input.model, provider: 'openai', tier: 'standard',
            keyId: 'key-1', keyMask: 'masked-key', sticky: false, byok: false, downgraded: false, probe: false,
          },
          attempts: [{ provider: 'openai', modelString: input.model, tier: 'standard', keyMask: 'masked-key', status: 200, outcome: 'success' }],
          outcome: 'success',
        },
      });
    });

    render(<Playground />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByText('Compare models side by side')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nexus Auto/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /GPT Test/ })).toHaveAttribute('aria-pressed', 'true');

    await user.type(screen.getByLabelText('Message'), 'Compare this prompt');
    await user.click(screen.getByRole('button', { name: 'Run 2 models' }));

    expect(await screen.findByText('GPT comparison answer')).toBeInTheDocument();
    expect(await screen.findByText('Auto route unavailable')).toBeInTheDocument();
    expect(mocks.runPlayground).toHaveBeenCalledTimes(2);
    expect(new Set(mocks.runPlayground.mock.calls.map(([input]) => input.model)))
      .toEqual(new Set(['alayra-nexus-1', 'gpt-test']));
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
  });
  it('shows a useful empty state when no chat model is ready', () => {
    mocks.useApi.mockReturnValue({ data: { models: [] }, loading: false, error: null, reload: vi.fn() });
    render(<Playground />);

    expect(screen.getByText('No chat models are ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('does not offer a viewer a provider-spending action', async () => {
    ready();
    sessionStorage.setItem('nx_identity', JSON.stringify({ role: 'viewer', userId: 'viewer', name: 'Viewer' }));
    render(<Playground />);

    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByPlaceholderText('Viewer access cannot run provider requests.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await waitFor(() => expect(mocks.runPlayground).not.toHaveBeenCalled());
  });
});
