import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const loginFn = vi.fn();
const claimStatus = vi.fn();
// The sign-in screen reads the public branding endpoint (P7.11) so an operator's own name and logo
// greet their team before anyone has a session.
const get = vi.fn();
vi.mock('../api', () => ({
  login: (p: string, c?: string, e?: string) => loginFn(p, c, e),
  GET:   (p: string) => get(p),
  fetchClaimStatus: () => claimStatus(),
  claimGateway: vi.fn(),
  recoverPassword: vi.fn(),
}));

import { Login } from './Login';

beforeEach(() => {
  loginFn.mockReset();
  get.mockReset();
  claimStatus.mockReset();
  get.mockResolvedValue({ companyName: '', logoDataUri: '' }); // unbranded by default
  // Claimed by default: the ordinary sign-in screen.
  claimStatus.mockResolvedValue({ unclaimed: false, carriesExistingTwoFactor: false });
});

const typeEmail = (v: string) =>
  fireEvent.input(screen.getByPlaceholderText(/you@company.com/i), { target: { value: v } });
const typePassword = (v: string) =>
  fireEvent.input(screen.getByPlaceholderText(/your password/i), { target: { value: v } });

/** The screen is chosen from the gateway's claim status, so nothing renders until that resolves. */
const signInScreen = async () =>
  waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());

describe('Login', () => {
  it('signs in with an email and password and notifies the app', async () => {
    loginFn.mockResolvedValue({ ok: true });
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);
    await signInScreen();

    typeEmail('ada@example.com');
    typePassword('s3cret');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(loginFn).toHaveBeenCalledWith('s3cret', undefined, 'ada@example.com');
  });

  it('reveals the code field when the gateway requires a second factor', async () => {
    loginFn.mockResolvedValueOnce({ ok: false, totpRequired: true, error: 'Authenticator code required.' });
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);
    await signInScreen();

    typeEmail('ada@example.com');
    typePassword('s3cret');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('123456')).toBeInTheDocument());
    expect(onAuthed).not.toHaveBeenCalled();

    // Second submit carries the code.
    loginFn.mockResolvedValueOnce({ ok: true });
    fireEvent.input(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalled());
    expect(loginFn).toHaveBeenLastCalledWith('s3cret', '123456', 'ada@example.com');
  });

  it('shows a plain error on a wrong password', async () => {
    loginFn.mockResolvedValue({ ok: false, error: 'Invalid credentials.' });
    render(<Login onAuthed={vi.fn()} />);
    await signInScreen();

    typePassword('nope');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText('Invalid credentials.')).toBeInTheDocument());
  });

  it('surfaces a lockout with its retry time', async () => {
    loginFn.mockResolvedValue({ ok: false, lockedOut: true, retryAfter: 900 });
    render(<Login onAuthed={vi.fn()} />);
    await signInScreen();

    typePassword('nope');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText(/try again in 900s/i)).toBeInTheDocument());
  });

  it('will not submit an empty password', async () => {
    render(<Login onAuthed={vi.fn()} />);
    await signInScreen();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('shows the operator’s branding, and the product’s own when unset (P7.11)', async () => {
    render(<Login onAuthed={vi.fn()} />);
    // Unset → the product's own name, so an unbranded install is unchanged.
    await waitFor(() => expect(get).toHaveBeenCalledWith('/branding'));
    expect(screen.getByText('Alayra Nexus')).toBeInTheDocument();

    get.mockResolvedValue({ companyName: 'Acme Corp', logoDataUri: 'data:image/png;base64,AAAA' });
    render(<Login onAuthed={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
  });

  // ── First run (Phase 7.13a) ────────────────────────────────────────────────

  it('shows the setup screen instead of sign-in when nobody has claimed the gateway', async () => {
    claimStatus.mockResolvedValue({ unclaimed: true, carriesExistingTwoFactor: false });
    render(<Login onAuthed={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Set up your gateway')).toBeInTheDocument());
    // Step 1 asks for the environment secret — proof you installed this, not merely that you found it.
    expect(screen.getByPlaceholderText('ADMIN_PASSWORD')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it('promises an existing authenticator will carry over, so claiming is not a reset', async () => {
    claimStatus.mockResolvedValue({ unclaimed: true, carriesExistingTwoFactor: true });
    render(<Login onAuthed={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/carry over to your new account/i)).toBeInTheDocument());
  });

  it('assumes a gateway it cannot reach is CLAIMED, never offering setup to a stranger', async () => {
    // fetchClaimStatus swallows failures into `unclaimed: false`. Showing the "create the owner
    // account" screen because a fetch failed would be the worst possible way to be wrong.
    claimStatus.mockResolvedValue({ unclaimed: false, carriesExistingTwoFactor: false });
    render(<Login onAuthed={vi.fn()} />);
    await signInScreen();
    expect(screen.queryByText('Set up your gateway')).not.toBeInTheDocument();
  });

  it('offers the recovery-key path for a forgotten password', async () => {
    render(<Login onAuthed={vi.fn()} />);
    await signInScreen();

    fireEvent.click(screen.getByRole('button', { name: /forgot your password/i }));
    await waitFor(() => expect(screen.getByText('Use your recovery key')).toBeInTheDocument());
    // No email is sent — delivery is off by default here, so the key is the credential.
    expect(screen.getByPlaceholderText(/xxxx-xxxx/i)).toBeInTheDocument();
  });
});
