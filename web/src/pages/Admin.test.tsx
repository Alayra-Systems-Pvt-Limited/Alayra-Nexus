import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { AdminUsersResponse, AdminInvitesResponse, AdminRole } from '../api';

const useApi = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const identity = vi.fn();

vi.mock('../hooks/useApi', () => ({ useApi: (p: string) => useApi(p) }));
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    POST: vi.fn(),
    PATCH: (p: string, b?: unknown) => patch(p, b),
    DEL: (p: string) => del(p),
    getIdentity: () => identity(),
  };
});

import { Admin } from './Admin';

const ROLES = {
  owner:  { label: 'Owner',  description: 'Full control, including managing people.' },
  admin:  { label: 'Admin',  description: 'Runs the gateway day to day.' },
  viewer: { label: 'Viewer', description: 'Read-only.' },
};

const users: AdminUsersResponse = {
  roles: ROLES,
  users: [
    {
      id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'owner', status: 'active',
      source: 'local', twoFactorEnabled: true, lastLoginAt: '2026-07-16T10:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'u2', email: 'bob@example.com', name: 'Bob', role: 'viewer', status: 'active',
      source: 'sso', twoFactorEnabled: false, lastLoginAt: null, createdAt: '2026-02-01T00:00:00Z',
    },
  ],
};

const invites: AdminInvitesResponse = {
  ttlDays: 7,
  invites: [
    { id: 'i1', email: 'carol@example.com', role: 'admin', expiresAt: '2026-07-30T00:00:00Z', expired: false, invitedBy: 'Ada', createdAt: '2026-07-16T00:00:00Z' },
    { id: 'i2', email: 'dave@example.com', role: 'viewer', expiresAt: '2026-07-01T00:00:00Z', expired: true, invitedBy: 'Ada', createdAt: '2026-06-20T00:00:00Z' },
  ],
};

function primeApi() {
  useApi.mockImplementation((path: string) => {
    if (path === '/admin/users')   return { data: users,   loading: false, error: null, reload: vi.fn() };
    if (path === '/admin/invites') return { data: invites, loading: false, error: null, reload: vi.fn() };
    return { data: null, loading: false, error: null, reload: vi.fn() };
  });
}

const asRole = (role: AdminRole, userId = 'u1') => identity.mockReturnValue({ role, userId, name: 'Ada' });

beforeEach(() => {
  vi.clearAllMocks();
  primeApi();
  asRole('owner');
});

describe('Admin — People', () => {
  it('lists everyone with their role, how they sign in, and their 2FA state', async () => {
    render(<Admin />);
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeInTheDocument());

    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    // Bob came from the identity provider, and says so — an operator needs to know which accounts
    // they cannot reset locally.
    expect(screen.getByText('Single sign-on')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();  // Ada's second factor
    expect(screen.getByText('Off')).toBeInTheDocument(); // Bob's
    expect(screen.getByText('Never')).toBeInTheDocument(); // Bob has never signed in
  });

  it('marks your own row and offers you no way to change yourself', async () => {
    // The server refuses this too; the UI's job is to explain rather than present a trap.
    render(<Admin />);
    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    expect(screen.getByText('Ask another owner')).toBeInTheDocument();
    // ...but Bob, who is not you, can be acted on.
    expect(screen.getByRole('button', { name: /suspend/i })).toBeInTheDocument();
  });

  it('lets an owner suspend and remove someone else', async () => {
    render(<Admin />);
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /suspend/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/users/u2', { status: 'suspended' }));

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    // Removal is confirmed, and the confirmation states the consequences that are easy to miss.
    await waitFor(() => expect(screen.getByText(/Remove Bob\?/)).toBeInTheDocument());
    expect(screen.getByText(/every API token they created is revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/stays in the audit trail/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove account/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/admin/users/u2'));
  });

  it('hides every management control from an admin, who is not an owner', async () => {
    // Managing people is the authority that separates an owner from an admin. The server enforces
    // it; this keeps an admin from clicking buttons that could only ever answer 403.
    asRole('admin', 'u3');
    render(<Admin />);
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suspend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
    // ...but they can still SEE who administers the gateway they operate.
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('shows an expired invite rather than hiding it', async () => {
    render(<Admin />);
    await waitFor(() => expect(screen.getByText('carol@example.com')).toBeInTheDocument());
    // An operator wondering why Dave never got in deserves to see that the link ran out.
    expect(screen.getByText('dave@example.com')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
});

describe('Admin — Backup tab', () => {
  it('is offered to an owner, and opens both halves of the story', async () => {
    render(<Admin />);
    fireEvent.click(screen.getByRole('tab', { name: /^backup$/i }));

    await waitFor(() => expect(screen.getByText(/take a backup/i)).toBeInTheDocument());
    // Taking one and restoring one live on the same screen deliberately: the second is only ever as
    // good as the first, and an operator who has never pressed the top button should see that.
    expect(screen.getByText(/restore from a backup/i)).toBeInTheDocument();
  });

  it('does not exist for an admin', () => {
    // Same reasoning as the Danger zone: both routes sit behind adminOwnerGuard, and a `replace`
    // additionally demands the master password. Hiding the tab keeps an admin out of a dead end.
    asRole('admin', 'u3');
    render(<Admin />);
    expect(screen.queryByRole('tab', { name: /^backup$/i })).not.toBeInTheDocument();
  });
});

describe('Admin — Danger zone tab', () => {
  it('is offered to an owner, and opens the factory reset', async () => {
    render(<Admin />);
    fireEvent.click(screen.getByRole('tab', { name: /danger zone/i }));
    await waitFor(() => expect(screen.getByText(/factory reset/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /erase everything/i })).toBeInTheDocument();
  });

  it('does not exist for an admin', () => {
    // Hiding the tab is presentation, not the boundary — the server demands an owner session
    // AND the master password — but a tab that could only ever answer 403 is a trap, not a feature.
    asRole('admin', 'u3');
    render(<Admin />);
    expect(screen.queryByRole('tab', { name: /danger zone/i })).not.toBeInTheDocument();
  });
});
