import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { NexusPool } from '../../api';

const patch = vi.fn();
vi.mock('../../api', () => ({
  PATCH: (path: string, body: unknown) => patch(path, body),
  ApiError: class ApiError extends Error {},
}));

import { EditProviderDialog } from './EditProviderDialog';

const pool: NexusPool = {
  id: 'p-1', name: 'OpenAI Prod', slug: 'openai-prod', provider: 'openai', tier: 'standard',
  preferredModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', modelFetchUrl: null,
  authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {}, keys: [],
};

beforeEach(() => { patch.mockReset(); patch.mockResolvedValue({ provider: pool }); });

describe('EditProviderDialog', () => {
  it('locks provider and slug, and PATCHes the edited pool without them', async () => {
    render(<EditProviderDialog pool={pool} onClose={vi.fn()} onSaved={vi.fn()} />);

    // Provider + slug are shown but fixed (disabled inputs), so they can't be edited.
    expect((screen.getByDisplayValue('openai') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByDisplayValue('openai-prod') as HTMLInputElement).disabled).toBe(true);

    fireEvent.input(screen.getByDisplayValue('OpenAI Prod'), { target: { value: 'OpenAI Main' } });
    fireEvent.click(screen.getByRole('button', { name: /save pool/i }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/admin/providers/p-1');
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'OpenAI Main', tier: 'standard', preferredModel: 'gpt-4o' });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('slug');
  });

  it('prefills existing extra headers and sends them back', async () => {
    const withHeaders: NexusPool = { ...pool, extraHeaders: { 'anthropic-version': '2023-06-01' } };
    render(<EditProviderDialog pool={withHeaders} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByDisplayValue('anthropic-version')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save pool/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect((patch.mock.calls[0][1] as Record<string, unknown>).extraHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
  });
});
