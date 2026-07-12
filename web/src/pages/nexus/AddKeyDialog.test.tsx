import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const post = vi.fn();
const fetchModels = vi.fn();
vi.mock('../../api', () => ({
  POST: (p: string, b: unknown) => post(p, b),
  GET: vi.fn(), PUT: vi.fn(),
  fetchProviderModels: (id: string, key?: string) => fetchModels(id, key),
  ApiError: class ApiError extends Error {},
}));

import { AddKeyDialog } from './AddKeyDialog';

const props = { providerId: 'p1', providerName: 'OpenAI Prod', provider: 'openai', tier: 'standard' };

beforeEach(() => { post.mockReset(); post.mockResolvedValue({}); fetchModels.mockReset(); });

describe('AddKeyDialog', () => {
  it('posts the key to the pool with numeric limits', async () => {
    const onChanged = vi.fn();
    render(<AddKeyDialog {...props} onClose={vi.fn()} onChanged={onChanged} />);

    fireEvent.input(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^add key$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/admin/providers/p1/keys');
    expect(body).toMatchObject({ apiKey: 'sk-secret', rpmLimit: 60, tpmLimit: 100000, maxUsers: 1000 });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('fetches models with the entered key and shows removable chips', async () => {
    fetchModels.mockResolvedValue({ models: ['gpt-4o', 'gpt-4o-mini'] });
    render(<AddKeyDialog {...props} onClose={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.input(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeInTheDocument());
    expect(fetchModels).toHaveBeenCalledWith('p1', 'sk-secret');
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
  });

  it('disables the submit until a key is entered', () => {
    render(<AddKeyDialog {...props} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^add key$/i })).toBeDisabled();
  });
});
