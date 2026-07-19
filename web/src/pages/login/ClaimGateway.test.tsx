import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const claim = vi.fn();
const put = vi.fn();
vi.mock('../../api', () => ({
  claimGateway: (input: unknown) => claim(input),
  PUT: (p: string, b?: unknown) => put(p, b),
}));

import { ClaimGateway } from './ClaimGateway';

const STRONG = 'correct-horse-Battery9';

beforeEach(() => {
  claim.mockReset();
  claim.mockResolvedValue({ ok: true, recoveryKey: 'aaaa-bbbb-cccc-dddd', twoFactorCarriedOver: false });
  put.mockReset(); put.mockResolvedValue({});
});

// Drive steps 1 → 2 → 3. Returns nothing; leaves the wizard on step 3.
async function walkToStep3(over: { password?: string; confirm?: string } = {}) {
  fireEvent.input(screen.getByPlaceholderText('ADMIN_PASSWORD'), { target: { value: 'env-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await screen.findByText('Create your account');
  fireEvent.input(screen.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
  fireEvent.input(screen.getByPlaceholderText('you@company.com'), { target: { value: 'ada@acme.com' } });
  fireEvent.input(screen.getByPlaceholderText('Your new password'), { target: { value: over.password ?? STRONG } });
  fireEvent.input(screen.getByPlaceholderText('Type it again'), { target: { value: over.confirm ?? STRONG } });
}

describe('ClaimGateway wizard', () => {
  it('walks the three steps and claims with the entered account', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);

    await walkToStep3();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText('Name your workspace');
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(claim).toHaveBeenCalledWith({
      masterPassword: 'env-secret', name: 'Ada', email: 'ada@acme.com', password: STRONG,
    }));
    // No org name entered → branding is not touched.
    expect(put).not.toHaveBeenCalled();
    // The one-time recovery key is revealed, and the flow stops there.
    await screen.findByText('Your owner account is ready.');
    expect(screen.getByText('aaaa-bbbb-cccc-dddd')).toBeInTheDocument();
  });

  it('blocks step 2 while the passwords do not match', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep3({ confirm: 'different-value-9' });

    // Continue is disabled on the mismatch; blurring the confirm surfaces the reason.
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    fireEvent.blur(screen.getByPlaceholderText('Type it again'));
    expect(screen.getByText(/don’t match/)).toBeInTheDocument();
  });

  it('saves the organization name to branding after a successful claim', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);

    await walkToStep3();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Name your workspace');
    fireEvent.input(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/branding', { companyName: 'Acme Corp' }));
    await screen.findByText('Your owner account is ready.');
  });
});
