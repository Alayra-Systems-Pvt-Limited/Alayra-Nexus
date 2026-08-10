import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const post = vi.fn();
vi.mock('../../api', () => ({
  POST: (p: string, b: unknown) => post(p, b),
  ApiError: class ApiError extends Error {},
}));

import { AddProviderDialog } from './AddProviderDialog';

beforeEach(() => { post.mockReset(); post.mockResolvedValue({}); });

describe('AddProviderDialog', () => {
  it('derives the slug from the name and posts to /admin/providers', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddProviderDialog onClose={onClose} onCreated={onCreated} />);

    fireEvent.input(screen.getByPlaceholderText('OpenAI Prod'), { target: { value: 'OpenAI Prod' } });
    fireEvent.click(screen.getByRole('button', { name: /create pool/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/admin/providers');
    expect(body).toMatchObject({ name: 'OpenAI Prod', slug: 'openai-prod', provider: 'openai', tier: 'standard' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('always shows the model-fetch fields and re-seeds base URL per provider', () => {
    render(<AddProviderDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    // Model ID path is shown for every provider now (Fetch Models needs it), defaulting to data[].id.
    expect(screen.getByPlaceholderText('data[].id')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('https://api.openai.com/v1') as HTMLInputElement).value).toBe('https://api.openai.com/v1');
    // Switching provider re-seeds the base URL to that provider's default.
    fireEvent.change(screen.getByRole('combobox', { name: /upstream provider/i }), { target: { value: 'groq' } });
    expect((screen.getByPlaceholderText('https://api.openai.com/v1') as HTMLInputElement).value).toBe('https://api.groq.com/openai/v1');
  });

  it('offers every provider in the preset table, not a shorter hardcoded list', () => {
    render(<AddProviderDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const options = Array.from(screen.getByRole('combobox', { name: /upstream provider/i })
      .querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    // The four this dialog could not previously create, all of which the gateway routes fine.
    expect(options).toEqual(expect.arrayContaining(['mistral', 'huggingface', 'cloudflare', 'cerebras']));
  });

  it('seeds a separate model-fetch URL only where base + /models is wrong', () => {
    render(<AddProviderDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const fetchUrl = () => screen.getByPlaceholderText('https://api.example.com/v1/models') as HTMLInputElement;
    // Left blank for a provider whose /models works — the fallback is better than a duplicate.
    expect(fetchUrl().value).toBe('');
    fireEvent.change(screen.getByRole('combobox', { name: /upstream provider/i }), { target: { value: 'cloudflare' } });
    // Cloudflare's OpenAI-compatible base answers /models with 405; its catalogue is elsewhere and
    // shaped differently, which is the whole reason these are two fields.
    expect(fetchUrl().value).toContain('/ai/models/search');
    expect((screen.getByPlaceholderText('data[].id') as HTMLInputElement).value).toBe('result[].name');
  });

  it('will not save a URL with an unfilled account placeholder in it', async () => {
    render(<AddProviderDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.input(screen.getByPlaceholderText('OpenAI Prod'), { target: { value: 'CF' } });
    fireEvent.change(screen.getByRole('combobox', { name: /upstream provider/i }), { target: { value: 'cloudflare' } });

    // Saving `{account_id}` verbatim produces a pool that looks configured and 404s on every
    // request, with the placeholder sitting in a URL nobody re-reads.
    fireEvent.click(screen.getByRole('button', { name: /create pool/i }));
    expect(post).not.toHaveBeenCalled();

    fireEvent.input(screen.getByPlaceholderText('0123456789abcdef0123456789abcdef'), { target: { value: 'acct-123' } });
    fireEvent.click(screen.getByRole('button', { name: /create pool/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    // Substituted in BOTH urls — the catalogue endpoint is account-scoped too, and filling only
    // the base would leave "Fetch models" broken on an otherwise working pool.
    expect(body.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1');
    expect(body.modelFetchUrl).toContain('/accounts/acct-123/ai/models/search');
    expect(JSON.stringify(body)).not.toContain('{account_id}');
  });

  it('says up front when a provider publishes no prices', () => {
    render(<AddProviderDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: /upstream provider/i }), { target: { value: 'mistral' } });
    expect(screen.getByText(/does not publish per-model prices/i)).toBeInTheDocument();

    // …and stays quiet for the two providers that do, so the note keeps meaning something.
    fireEvent.change(screen.getByRole('combobox', { name: /upstream provider/i }), { target: { value: 'groq' } });
    expect(screen.queryByText(/does not publish per-model prices/i)).not.toBeInTheDocument();
  });
});
