import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const get = vi.fn();
const put = vi.fn();
vi.mock('../api', () => ({
  GET: (p: string) => get(p),
  PUT: (p: string, b: unknown) => put(p, b),
  ApiError: class ApiError extends Error {},
}));

import { Settings } from './Settings';

const CONFIGS: Record<string, unknown> = {
  '/admin/settings/routing':       { costWeight: 0 },
  '/admin/settings/cache':         { enabled: false, ttlSeconds: 3600 },
  '/admin/settings/guardrails':    { enabled: false, bufferedSafe: false, rules: [] },
  '/admin/settings/notifications': {
    enabled: true, from: 'a@b.com', to: ['ops@b.com'], webhookUrl: '',
    events: { keyBanned: true, breakerOpened: false, adminLockout: false, budgetThreshold: false, tierExhausted: false },
    windowSeconds: 3600, resendKeySet: true, resendKeyMasked: 're_…9f2a',
  },
  '/admin/settings/ssrf':          { allowPrivate: false, allowList: ['proxy.internal'], envAllowList: ['env.host'] },
  '/admin/settings/compliance':    { auditRetentionDays: 90, usageRetentionDays: 365, anonymizeUsage: false },
};

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  get.mockImplementation((p: string) => Promise.resolve(CONFIGS[p] ?? {}));
  put.mockImplementation((p: string) => Promise.resolve(CONFIGS[p]));
});

const openTab = async (label: string) => {
  fireEvent.click(screen.getByRole('tab', { name: label }));
};

describe('Settings — routing', () => {
  it('describes the cost/speed weight in words, not just a number', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/first available key wins/i)).toBeInTheDocument());
  });
});

describe('Settings — cache', () => {
  it('saves the toggle and TTL, and warns about staleness', async () => {
    render(<Settings />);
    await openTab('Cache');
    await waitFor(() => expect(screen.getByRole('switch', { name: /serve repeat requests from cache/i })).toBeInTheDocument());

    expect(screen.getByText(/Staleness is the trade-off/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /serve repeat requests from cache/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/settings/cache', { enabled: true, ttlSeconds: 3600 }));
  });

  it('cannot be saved until something actually changed', async () => {
    render(<Settings />);
    await openTab('Cache');
    await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled());
  });

  it('stops claiming unsaved changes once the save lands', async () => {
    // The panel re-seeds from what the gateway says it stored. Without that it would compare the
    // edit against the stale load forever and go on insisting there are unsaved changes.
    put.mockResolvedValue({ enabled: true, ttlSeconds: 3600 });
    render(<Settings />);
    await openTab('Cache');
    await waitFor(() => expect(screen.getByRole('switch', { name: /serve repeat requests/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('switch', { name: /serve repeat requests/i }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    // …and the re-seeded form reflects what was actually stored.
    expect(screen.getByRole('switch', { name: /serve repeat requests/i }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Settings — notifications', () => {
  it('never sends an empty API key, so an unrelated save cannot wipe the stored one', async () => {
    render(<Settings />);
    await openTab('Notifications');
    await waitFor(() => expect(screen.getByText(/re_…9f2a/)).toBeInTheDocument());

    // Change something unrelated to the key.
    fireEvent.click(screen.getByRole('switch', { name: /A provider key is banned/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('resendApiKey'); // the stored key survives
  });

  it('sends the API key when one is actually typed', async () => {
    render(<Settings />);
    await openTab('Notifications');
    await waitFor(() => expect(screen.getByPlaceholderText(/Leave blank to keep/i)).toBeInTheDocument());

    fireEvent.input(screen.getByPlaceholderText(/Leave blank to keep/i), { target: { value: 're_new' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toMatchObject({ resendApiKey: 're_new' });
  });
});

describe('Settings — guardrails', () => {
  it('refuses to save a rule whose regex will not compile', async () => {
    render(<Settings />);
    await openTab('Guardrails');
    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    fireEvent.input(screen.getByPlaceholderText('Rule name'), { target: { value: 'bad' } });
    fireEvent.input(screen.getByPlaceholderText('regular expression'), { target: { value: '([unclosed' } });

    expect(await screen.findByText(/not a valid regular expression/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('Settings — network policy', () => {
  it('warns loudly when private addresses are allowed', async () => {
    render(<Settings />);
    await openTab('Network');
    await waitFor(() => expect(screen.getByRole('switch', { name: /allow private and internal/i })).toBeInTheDocument());

    expect(screen.queryByText(/lowers a real defence/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /allow private and internal/i }));
    expect(await screen.findByText(/lowers a real defence/i)).toBeInTheDocument();
  });

  it('shows environment-supplied hosts as read-only facts', async () => {
    render(<Settings />);
    await openTab('Network');
    await waitFor(() => expect(screen.getByText('env.host')).toBeInTheDocument());
    expect(screen.getByText(/cannot be changed from here/i)).toBeInTheDocument();
  });
});

describe('Settings — compliance', () => {
  it('says plainly that deleted records are gone', async () => {
    render(<Settings />);
    await openTab('Compliance');
    await waitFor(() => expect(screen.getByText(/Deletion is permanent/i)).toBeInTheDocument());
  });
});

describe('Settings — appearance', () => {
  it('applies immediately and has nothing to save', async () => {
    render(<Settings />);
    await openTab('Appearance');
    await waitFor(() => expect(screen.getByText(/applied immediately/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });
});
