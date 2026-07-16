import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const loginFn = vi.fn();
// The sign-in screen reads the public branding endpoint (P7.11) so an operator's own name and logo
// greet their team before anyone has a session.
const get = vi.fn();
vi.mock('../api', () => ({
  login: (p: string, c?: string) => loginFn(p, c),
  GET:   (p: string) => get(p),
}));

import { Login } from './Login';

beforeEach(() => {
  loginFn.mockReset();
  get.mockReset();
  get.mockResolvedValue({ companyName: '', logoDataUri: '' }); // unbranded by default
});

const typePassword = (v: string) =>
  fireEvent.input(screen.getByPlaceholderText(/your admin password/i), { target: { value: v } });

describe('Login', () => {
  it('signs in with a correct password and notifies the app', async () => {
    loginFn.mockResolvedValue({ ok: true });
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);

    typePassword('s3cret');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(loginFn).toHaveBeenCalledWith('s3cret', undefined);
  });

  it('reveals the code field when the gateway requires a second factor', async () => {
    loginFn.mockResolvedValueOnce({ ok: false, totpRequired: true, error: 'Authenticator code required.' });
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);

    typePassword('s3cret');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('123456')).toBeInTheDocument());
    expect(onAuthed).not.toHaveBeenCalled();

    // Second submit carries the code.
    loginFn.mockResolvedValueOnce({ ok: true });
    fireEvent.input(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalled());
    expect(loginFn).toHaveBeenLastCalledWith('s3cret', '123456');
  });

  it('shows a plain error on a wrong password', async () => {
    loginFn.mockResolvedValue({ ok: false, error: 'Invalid credentials.' });
    render(<Login onAuthed={vi.fn()} />);

    typePassword('nope');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText('Invalid credentials.')).toBeInTheDocument());
  });

  it('surfaces a lockout with its retry time', async () => {
    loginFn.mockResolvedValue({ ok: false, lockedOut: true, retryAfter: 900 });
    render(<Login onAuthed={vi.fn()} />);

    typePassword('nope');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText(/try again in 900s/i)).toBeInTheDocument());
  });

  it('will not submit an empty password', () => {
    render(<Login onAuthed={vi.fn()} />);
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
});
