import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const get  = vi.fn();
const post = vi.fn();
const del  = vi.fn();
vi.mock('../api', () => ({
  GET:  (p: string) => get(p),
  POST: (p: string, b?: unknown) => post(p, b),
  DEL:  (p: string) => del(p),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
  },
}));

import { Security } from './Security';
import { ApiError } from '../api';

const AUTH_OFF = { twoFactorEnabled: false, enrolmentPending: false, recoveryCodesRemaining: 0, sessionTtlSeconds: 43200, maxLoginAttempts: 5, lockoutSeconds: 900 };
const AUTH_ON  = { ...AUTH_OFF, twoFactorEnabled: true, recoveryCodesRemaining: 8 };
const SSRF     = { allowPrivate: false, allowList: [], envAllowList: [] };

function route(over: { auth?: unknown; tokens?: unknown } = {}) {
  get.mockImplementation((p: string) => {
    if (p === '/admin/auth/status')   return Promise.resolve(over.auth ?? AUTH_OFF);
    if (p === '/admin/tokens')        return Promise.resolve(over.tokens ?? { tokens: [] });
    if (p === '/admin/settings/ssrf') return Promise.resolve(SSRF);
    return Promise.resolve({});
  });
}

const openTokens = () => fireEvent.click(screen.getByRole('tab', { name: 'API tokens' }));

beforeEach(() => { get.mockReset(); post.mockReset(); del.mockReset(); route(); });

describe('Security — sign-in', () => {
  it('shows 2FA off with the sign-in policy facts', async () => {
    render(<Security />);
    await waitFor(() => expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument());
    expect(screen.getByText(/12 hours/)).toBeInTheDocument();   // session ttl
    expect(screen.getByText(/15 minutes/)).toBeInTheDocument(); // lockout window
  });

  it('walks enrolment through to the one-time recovery codes', async () => {
    post.mockImplementation((p: string) => {
      if (p === '/admin/auth/totp/enrol')   return Promise.resolve({ secret: 'ABC123SECRET', otpauthUri: 'otpauth://totp/x' });
      if (p === '/admin/auth/totp/confirm') return Promise.resolve({ recoveryCodes: ['aaa11-bbb22', 'ccc33-ddd44'] });
      return Promise.resolve({});
    });
    render(<Security />);
    await waitFor(() => expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set up two-factor/i }));
    // The QR is the primary path now; assert it rendered, named for assistive tech.
    await waitFor(() => expect(screen.getByRole('img', { name: /two-factor setup qr code/i })).toBeInTheDocument());
    // The typed key is a fallback behind a toggle — reveal it, then assert it and the otpauth URI.
    fireEvent.click(screen.getByRole('button', { name: /enter the key by hand/i }));
    expect(screen.getByText('ABC123SECRET')).toBeInTheDocument();
    expect(screen.getByText('otpauth://totp/x')).toBeInTheDocument();

    fireEvent.input(screen.getByPlaceholderText('123456'), { target: { value: '000111' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm & enable/i }));

    await waitFor(() => expect(screen.getByText(/Save these recovery codes/i)).toBeInTheDocument());
    expect(screen.getByText('aaa11-bbb22')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/admin/auth/totp/confirm', { code: '000111' });
  });

  it('shows an owner-only action as read-only for a viewer', async () => {
    post.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(<Security />);
    await waitFor(() => expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set up two-factor/i }));
    await waitFor(() => expect(screen.getByText(/read-only \(viewer\)/i)).toBeInTheDocument());
  });

  it('shows 2FA on with the disable and regenerate controls', async () => {
    route({ auth: AUTH_ON });
    render(<Security />);
    await waitFor(() => expect(screen.getByText(/8 recovery codes remaining/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /turn off two-factor/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate recovery codes/i })).toBeInTheDocument();
  });
});

describe('Security — API tokens', () => {
  it('creates a token and reveals the plaintext once', async () => {
    post.mockResolvedValue({ token: { token: 'nxa_plaintext_once', name: 'ci' } });
    render(<Security />);
    openTokens();
    await waitFor(() => expect(screen.getByPlaceholderText('ci-pipeline')).toBeInTheDocument());

    fireEvent.input(screen.getByPlaceholderText('ci-pipeline'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => expect(screen.getByText('nxa_plaintext_once')).toBeInTheDocument());
    expect(screen.getByText(/only time the full token is shown/i)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/admin/tokens', { name: 'ci', role: 'owner' });
  });

  it('revokes a token only after confirming', async () => {
    route({ tokens: { tokens: [{ id: 't1', name: 'ci', maskedKey: 'nxa_1234••••abcd', role: 'owner', lastUsedAt: null, createdAt: new Date().toISOString() }] } });
    render(<Security />);
    openTokens();
    await waitFor(() => expect(screen.getByRole('button', { name: /revoke ci/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /revoke ci/i })); // opens confirm
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /revoke token/i })); // confirm

    await waitFor(() => expect(del).toHaveBeenCalledWith('/admin/tokens/t1'));
  });

  it('offers an ADMIN no mint or revoke — tokens are owner ground (7.13b)', async () => {
    // Minting an owner token is handing out owner authority, so even an admin only looks.
    sessionStorage.setItem('nx_identity', JSON.stringify({ role: 'admin', userId: 'u2', name: 'Ada' }));
    route({ tokens: { tokens: [{ id: 't1', name: 'ci', maskedKey: 'nxa_1234••••abcd', role: 'owner', lastUsedAt: null, createdAt: new Date().toISOString() }] } });
    render(<Security />);
    openTokens();
    await waitFor(() => expect(screen.getByText('ci')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /create token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke ci/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only an owner can create or revoke/i)).toBeInTheDocument();
  });
});
