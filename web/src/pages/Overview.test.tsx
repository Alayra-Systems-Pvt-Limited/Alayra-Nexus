import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import type { Overview as OverviewData } from '../api';

// The page is pure composition over useApi, so the hook is mocked to drive each state.
const useApi = vi.fn();
vi.mock('../hooks/useApi', () => ({ useApi: () => useApi() }));

import { Overview } from './Overview';

const sample: OverviewData = {
  stats: { totalRequests: 1200, totalCostUsd: 12.5, inputTokens7d: 3400, outputTokens7d: 1500, activeKeys: 4, activeModels: 9, activeTeams: 2 },
  series7d: Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-0${i + 1}`, inputTokens: i, outputTokens: i, tokens: i * 2, usd: i, requests: i })),
  topModels: [{ model: 'gpt-4o', tokens: 100, usd: 1 }],
  topKeys: [{ id: 'k1', name: 'Alpha', totalTokens: 100, requests: 5, estimatedUsd: 1 }],
  recentLogs: [{ id: 'a1', action: 'keys.create', method: 'POST', actorRole: 'owner', status: 200, target: null, createdAt: '2026-07-11T10:00:00Z' }],
};

beforeEach(() => vi.clearAllMocks());

describe('Overview', () => {
  it('shows a loading state before data arrives', () => {
    useApi.mockReturnValue({ data: null, loading: true, error: null, reload: vi.fn() });
    render(<Overview />);
    expect(screen.getByText(/Loading telemetry/i)).toBeInTheDocument();
  });

  it('shows an error state with a retry when the gateway is unreachable', () => {
    useApi.mockReturnValue({ data: null, loading: false, error: 'HTTP 500', reload: vi.fn() });
    render(<Overview />);
    expect(screen.getByText(/Couldn’t reach the gateway/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders live stats, charts, and tables from the payload', () => {
    useApi.mockReturnValue({ data: sample, loading: false, error: null, reload: vi.fn() });
    render(<Overview />);
    expect(screen.getByText('1.2K')).toBeInTheDocument();          // total requests, compacted
    expect(screen.getByText('$12.50')).toBeInTheDocument();        // total cost
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();        // top model
    expect(screen.getByText('Alpha')).toBeInTheDocument();         // top key
    expect(screen.getByText(/keys\.create/)).toBeInTheDocument();  // recent activity
    expect(screen.getByRole('img', { name: 'Cost over the last 7 days' })).toBeInTheDocument();
  });
});
