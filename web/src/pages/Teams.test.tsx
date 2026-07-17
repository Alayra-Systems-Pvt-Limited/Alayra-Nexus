import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const get   = vi.fn();
const post  = vi.fn();
const patch = vi.fn();
const del   = vi.fn();
vi.mock('../api', () => ({
  GET:   (p: string) => get(p),
  POST:  (p: string, b?: unknown) => post(p, b),
  PATCH: (p: string, b?: unknown) => patch(p, b),
  DEL:   (p: string) => del(p),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
  },
}));

import { Teams } from './Teams';

const team = (over: Record<string, unknown> = {}) => ({
  id: 't1', name: 'Frontend', status: 'active', assignedTier: 'fast', overBudgetAction: 'block',
  budgetUsd: 100, budgetPeriod: 'monthly', keyCount: 2, spendUsd: 40, createdAt: '2026-07-01T00:00:00Z',
  ...over,
});
const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1', name: 'Abbas', maskedKey: 'nx_ab••••••••1234', team: { id: 't1', name: 'Frontend' }, createdAt: '2026-07-10T00:00:00Z',
  ...over,
});
const stats = (over: Record<string, unknown> = {}) => ({
  team: {
    id: 't1', name: 'Frontend', status: 'active', assignedTier: 'fast', overBudgetAction: 'downgrade',
    budgetUsd: 100, budgetPeriod: 'monthly', budgetSpendUsd: 40, keyCount: 2,
  },
  period: '7d', since: '2026-07-09T00:00:00Z', until: '2026-07-16T00:00:00Z',
  totals: { requests: 10, successes: 9, errors: 1, successRate: 0.9, totalTokens: 5000, estimatedUsd: 3.5, avgLatencyMs: 640 },
  byDay:   [{ date: '2026-07-15', requests: 10, usd: 3.5, tokens: 5000 }],
  byModel: [{ model: 'gpt-4o', requests: 8, tokens: 4000, usd: 3 }],
  members: [
    { id: 'k1', name: 'Abbas', maskedKey: 'nx_ab••••1234', requests: 8, tokens: 4000, usd: 3, lastUsedAt: '2026-07-15T10:00:00Z' },
    { id: 'k2', name: 'CI',    maskedKey: 'nx_ci••••9876', requests: 0, tokens: 0,    usd: 0, lastUsedAt: null },
  ],
  ...over,
});

beforeEach(() => {
  get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset();
  get.mockImplementation((p: string) => {
    if (p === '/admin/teams')                return Promise.resolve({ teams: [team()] });
    if (p === '/admin/team-keys')            return Promise.resolve({ keys: [key()] });
    if (p.startsWith('/admin/teams/t1/stats')) return Promise.resolve(stats());
    return Promise.resolve({});
  });
  post.mockResolvedValue({ team: { id: 't2' }, key: { name: 'CI', plainKey: 'nx_plaintext_once' } });
  patch.mockResolvedValue({});
  del.mockResolvedValue({ success: true });
});

describe('Teams — list', () => {
  it('shows a team with its tier, budget, and status', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    expect(screen.getByText('Fast')).toBeInTheDocument();           // preferred routing tier badge
    expect(screen.getByText(/\$40\.00 \/ \$100\.00/)).toBeInTheDocument(); // spend / budget
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('creates a team through the modal', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByRole('button', { name: /new team/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /new team/i }));

    const nameInput = await screen.findByPlaceholderText(/Frontend, Data Science/i);
    fireEvent.input(nameInput, { target: { value: 'Data Science' } });
    fireEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/teams', expect.objectContaining({ name: 'Data Science' })));
  });

  it('deletes a team only after confirming', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByRole('button', { name: /delete frontend/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /delete frontend/i }));

    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /delete team/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/admin/teams/t1'));
  });

  it('editing a BYOK-isolated team does not quietly re-enable shared-pool fallback', async () => {
    // The edit draft once hardcoded byokFallback: true, so renaming an isolated team moved its
    // traffic back onto shared keys — an isolation breach dressed as a rename. The draft must
    // seed from the row and the PATCH must carry what the row said.
    get.mockImplementation((p: string) => (p === '/admin/teams'
      ? Promise.resolve({ teams: [team({ byokFallback: false })] })
      : Promise.resolve({ keys: [] })));
    render(<Teams />);
    await waitFor(() => expect(screen.getByRole('button', { name: /edit frontend/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /edit frontend/i }));

    const nameInput = await screen.findByPlaceholderText(/Frontend, Data Science/i);
    fireEvent.input(nameInput, { target: { value: 'Frontend Platform' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/teams/t1',
      expect.objectContaining({ name: 'Frontend Platform', byokFallback: false })));
  });
});

describe('Teams — access keys', () => {
  it('lists keys and shows the plaintext once on creation', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /access keys/i }));

    await waitFor(() => expect(screen.getByText('Abbas')).toBeInTheDocument());

    fireEvent.input(screen.getByPlaceholderText(/CI pipeline/i), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/team-keys', { name: 'CI', teamId: null }));
    await waitFor(() => expect(screen.getByText('nx_plaintext_once')).toBeInTheDocument());
  });

  it('revokes a key only after confirming', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /access keys/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /revoke abbas/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /revoke abbas/i }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /revoke key/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/admin/team-keys/k1'));
  });

  it('filters the global key list by search text', async () => {
    get.mockImplementation((p: string) => {
      if (p === '/admin/teams')     return Promise.resolve({ teams: [team()] });
      if (p === '/admin/team-keys') return Promise.resolve({ keys: [key(), key({ id: 'k2', name: 'CI pipeline' })] });
      return Promise.resolve({});
    });
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /access keys/i }));
    await waitFor(() => expect(screen.getByText('Abbas')).toBeInTheDocument());
    expect(screen.getByText('CI pipeline')).toBeInTheDocument();

    fireEvent.input(screen.getByPlaceholderText(/search name or key/i), { target: { value: 'abbas' } });
    await waitFor(() => expect(screen.queryByText('CI pipeline')).not.toBeInTheDocument());
    expect(screen.getByText('Abbas')).toBeInTheDocument();
  });
});

describe('Teams — team stats (P7.10)', () => {
  it('loads the first team and shows its spend and budget against the enforced cap', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /team stats/i }));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/teams/t1/stats?period=7d'));
    // Spend for the viewing window, and the budget window's spend against the cap — two figures on
    // purpose, so a 7-day spend is never mistaken for progress against a monthly cap. ($3.50 appears
    // both on the Spend card and as the cost chart's headline, hence getAllByText.)
    await waitFor(() => expect(screen.getAllByText('$3.50').length).toBeGreaterThan(0));
    expect(screen.getByText(/\$40\.00 \/ \$100\.00/)).toBeInTheDocument();
    // The configured over-budget action is stated, not implied.
    expect(screen.getByText(/downgrades to the fast tier/i)).toBeInTheDocument();
  });

  it('refetches when the period changes', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /team stats/i }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/teams/t1/stats?period=7d'));

    fireEvent.click(screen.getByRole('tab', { name: /30 days/i }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/teams/t1/stats?period=30d'));
  });

  it('lists every member including an idle key, and expands one for detail', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /team stats/i }));

    // An unused key is still listed rather than dropped — "nobody used this" is the point.
    await waitFor(() => expect(screen.getByText('CI')).toBeInTheDocument());
    expect(screen.getByText('idle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /abbas/i }));
    await waitFor(() => expect(screen.getByText('Share of team')).toBeInTheDocument());
    expect(screen.getByText('85.7%')).toBeInTheDocument(); // 3 of 3.50
  });
});

describe('Teams — as a viewer (7.13b)', () => {
  // The server refuses every one of these writes; the UI's job is to not offer them. The DATA
  // stays visible — a viewer exists to look.
  beforeEach(() => {
    sessionStorage.setItem('nx_identity', JSON.stringify({ role: 'viewer', userId: 'u9', name: 'V' }));
  });

  it('sees the teams but no way to change them', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /new team/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit frontend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete frontend/i })).not.toBeInTheDocument();
  });

  it('sees the access keys but cannot create, copy, or revoke one', async () => {
    render(<Teams />);
    await waitFor(() => expect(screen.getByText('Frontend')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /access keys/i }));
    await waitFor(() => expect(screen.getByText('Abbas')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /create key/i })).not.toBeInTheDocument();
    // Copy is withheld with the rest: it reveals the live key, and a copyable credential is
    // not "read-only" in any sense that matters.
    expect(screen.queryByRole('button', { name: /copy abbas/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke abbas/i })).not.toBeInTheDocument();
    expect(screen.getByText(/needs write access/i)).toBeInTheDocument();
  });
});
