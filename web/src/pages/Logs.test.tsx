import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { AuditEntry } from '../api';

const get = vi.fn();
vi.mock('../api', () => ({ GET: (p: string) => get(p) }));

import { Logs } from './Logs';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'a1', action: 'keys.ban', method: 'POST', actorRole: 'owner', actor: 'password',
  actorName: 'Abbas', target: '/admin/keys/k1', ip: '10.0.0.4', status: 200, detail: null,
  createdAt: new Date().toISOString(), ...over,
});

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ entries: [entry(), entry({ id: 'a2', action: 'auth.login', status: 401, actorRole: 'system' })] });
});

describe('Logs', () => {
  it('lists the trail and marks it read-only', async () => {
    render(<Logs />);
    await waitFor(() => expect(screen.getByText('keys.ban')).toBeInTheDocument());
    expect(screen.getByText('read-only')).toBeInTheDocument();
    expect(screen.getByText(/cannot be edited or deleted/i)).toBeInTheDocument();
  });

  it('names the person who acted, not just their role', async () => {
    // Accounts landed in 7.13a and the trail has carried names since — but this page kept
    // rendering only the role, so the promise was true in the database and invisible on
    // screen. Found by the e2e browser suite looking for a removed person's name.
    render(<Logs />);
    await waitFor(() => expect(screen.getAllByText('Abbas').length).toBeGreaterThan(0));
  });

  it('keeps the action slug verbatim, so the dashboard and the logs agree', async () => {
    render(<Logs />);
    await waitFor(() => expect(screen.getByText('auth.login')).toBeInTheDocument());
  });

  it('filters by action and by actor, and asks the server for it', async () => {
    render(<Logs />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/audit?limit=50'));

    fireEvent.input(screen.getByPlaceholderText(/Filter by action/i), { target: { value: 'settings' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/audit?action=settings&limit=50'));

    fireEvent.change(screen.getByDisplayValue('Any actor'), { target: { value: 'owner' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/audit?action=settings&actorRole=owner&limit=50'));
  });

  it('offers a retry when the trail cannot be read', async () => {
    get.mockRejectedValue(new Error('nope'));
    render(<Logs />);
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());
  });

  it('says so when a filter matches nothing', async () => {
    get.mockResolvedValue({ entries: [] });
    render(<Logs />);
    fireEvent.input(screen.getByPlaceholderText(/Filter by action/i), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByText(/No entries match that filter/i)).toBeInTheDocument());
  });
});
