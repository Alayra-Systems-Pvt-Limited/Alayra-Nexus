import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const claim = vi.fn();
const put = vi.fn();
const downloaded = vi.fn();
vi.mock('../../api', () => ({
  claimGateway: (input: unknown) => claim(input),
  PUT: (p: string, b?: unknown) => put(p, b),
}));
vi.mock('../../lib/download', () => ({ download: (n: string, c: string) => downloaded(n, c) }));

import { ClaimGateway } from './ClaimGateway';

const STRONG = 'correct-horse-Battery9';
const MASTER = 'ab'.repeat(32);

beforeEach(() => {
  claim.mockReset();
  claim.mockResolvedValue({
    ok: true, recoveryKey: 'aaaa-bbbb-cccc-dddd', twoFactorCarriedOver: false,
    masterEncryptionKey: MASTER, backupRecoveryKeySet: true,
  });
  put.mockReset(); put.mockResolvedValue({});
  downloaded.mockReset();
});

/** Drive steps 1 → 2, leaving the wizard on step 2 with a valid account filled in. */
async function fillAccount(over: { password?: string; confirm?: string } = {}) {
  fireEvent.input(screen.getByPlaceholderText('ADMIN_PASSWORD'), { target: { value: 'env-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await screen.findByText('Create your account');
  fireEvent.input(screen.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
  fireEvent.input(screen.getByPlaceholderText('you@company.com'), { target: { value: 'ada@acme.com' } });
  fireEvent.input(screen.getByPlaceholderText('Your new password'), { target: { value: over.password ?? STRONG } });
  fireEvent.input(screen.getByPlaceholderText('Type it again'), { target: { value: over.confirm ?? STRONG } });
}

/** Steps 1 → 4, stopping on the backup-passphrase step without submitting. */
async function walkToStep4(over: { orgName?: string } = {}) {
  await fillAccount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await screen.findByText('Name your workspace');
  if (over.orgName) {
    fireEvent.input(screen.getByPlaceholderText('Acme Corp'), { target: { value: over.orgName } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Protect your backups');
}

/** The passphrase the wizard generated, read off the screen. */
const shownPassphrase = () => screen.getByText(/^[a-z]+(-[a-z]+){7}$/).textContent!;

/**
 * Find a button by the text inside it.
 *
 * Not getByRole(name): the buttons nested inside a `Field` sit within its `<label>`, and the
 * accessible-name computation does not resolve to their own text there. Their visible label is what
 * an operator clicks, so it is what the test asserts on.
 */
const clickButton = (text: RegExp) => {
  const button = screen.getAllByRole('button').find((b) => text.test(b.textContent ?? ''));
  if (!button) throw new Error(`No button matching ${text}`);
  fireEvent.click(button);
};

describe('ClaimGateway wizard', () => {
  it('walks all four steps and claims with the entered account', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);

    await walkToStep4();
    const passphrase = shownPassphrase();
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(claim).toHaveBeenCalledWith({
      masterPassword: 'env-secret', name: 'Ada', email: 'ada@acme.com', password: STRONG,
      backupPassphrase: passphrase,
    }));
    expect(put).not.toHaveBeenCalled();
    await screen.findByText('Your owner account is ready.');
    expect(screen.getByText('aaaa-bbbb-cccc-dddd')).toBeInTheDocument();
  });

  it('blocks step 2 while the passwords do not match', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await fillAccount({ confirm: 'different-value-9' });

    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    fireEvent.blur(screen.getByPlaceholderText('Type it again'));
    expect(screen.getByText(/don’t match/)).toBeInTheDocument();
  });

  it('re-enables and shows an error when the claim throws, rather than locking the wizard', async () => {
    claim.mockRejectedValue(new Error('network down'));
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);

    await walkToStep4();
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(screen.getByText(/could not create your account/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /create owner account/i })).toBeEnabled();
  });

  it('saves the organization name to branding after a successful claim', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);

    await walkToStep4({ orgName: 'Acme Corp' });
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/branding', { companyName: 'Acme Corp' }));
    await screen.findByText('Your owner account is ready.');
  });
});

describe('the backup passphrase step (C6)', () => {
  it('offers a generated passphrase by default', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();

    expect(shownPassphrase().split('-')).toHaveLength(8);
  });

  it('can generate a different one', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();

    const first = shownPassphrase();
    clickButton(/new one/i);
    await waitFor(() => expect(shownPassphrase()).not.toBe(first));
  });

  it('lets the operator choose their own, and sends that instead', async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();

    fireEvent.click(screen.getByRole('button', { name: /choose my own/i }));
    const field = await screen.findByPlaceholderText(/still have in a year/i);
    fireEvent.input(field, { target: { value: 'my own long passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));

    await waitFor(() => expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ backupPassphrase: 'my own long passphrase' }),
    ));
  });

  it('will not submit a self-chosen passphrase that is too short for the server', async () => {
    // The server refuses under 12 characters. Letting it through here would produce a setup screen
    // that fails at the last step for a reason the operator was never told.
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();

    fireEvent.click(screen.getByRole('button', { name: /choose my own/i }));
    fireEvent.input(await screen.findByPlaceholderText(/still have in a year/i), { target: { value: 'short' } });

    expect(screen.getByRole('button', { name: /create owner account/i })).toBeDisabled();
  });
});

describe('the Recovery Kit (C6)', () => {
  const reachKit = async () => {
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();
    const passphrase = shownPassphrase();
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));
    await screen.findByText('Your owner account is ready.');
    return passphrase;
  };

  it('will not let the operator continue until they prove they saved it', async () => {
    // A checkbox saying "I saved it" is a lie detector that does not work — everybody ticks it.
    const onAuthed = vi.fn();
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={onAuthed} />);
    await walkToStep4();
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));
    await screen.findByText('Your owner account is ready.');

    expect(screen.getByRole('button', { name: /confirm your passphrase to continue/i })).toBeDisabled();
    expect(onAuthed).not.toHaveBeenCalled();
  });

  it('accepts the passphrase pasted back, and only then continues', async () => {
    const passphrase = await reachKit();

    fireEvent.input(screen.getByPlaceholderText(/copper-lantern-drift/i), { target: { value: passphrase } });
    await waitFor(() => expect(screen.getByRole('button', { name: /continue to your gateway/i })).toBeEnabled());
  });

  it('rejects a near miss and says so', async () => {
    const passphrase = await reachKit();

    fireEvent.input(screen.getByPlaceholderText(/copper-lantern-drift/i), { target: { value: `${passphrase}x` } });
    expect(await screen.findByText(/does not match/i)).toBeInTheDocument();
  });

  it('downloads one file holding all three secrets', async () => {
    const passphrase = await reachKit();
    fireEvent.click(screen.getByRole('button', { name: /download recovery kit/i }));

    expect(downloaded).toHaveBeenCalledTimes(1);
    const [filename, contents] = downloaded.mock.calls[0] as [string, string];
    expect(filename).toBe('alayra-nexus-recovery-kit.txt');
    expect(contents).toContain('aaaa-bbbb-cccc-dddd');   // account recovery key
    expect(contents).toContain(MASTER);                  // master encryption key
    expect(contents).toContain(passphrase);              // backup passphrase, because we generated it
  });

  it('leaves a blank line instead of writing a self-chosen passphrase into the file', async () => {
    // People reuse passwords. A leaked kit containing one they chose would expose whatever else it
    // unlocks, so the file gets a line to write on rather than the phrase itself.
    render(<ClaimGateway brand={<div />} carriesExistingTwoFactor={false} onAuthed={vi.fn()} />);
    await walkToStep4();
    fireEvent.click(screen.getByRole('button', { name: /choose my own/i }));
    fireEvent.input(await screen.findByPlaceholderText(/still have in a year/i), {
      target: { value: 'a-passphrase-i-reuse-everywhere' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));
    await screen.findByText('Your owner account is ready.');

    fireEvent.click(screen.getByRole('button', { name: /download recovery kit/i }));
    const [, contents] = downloaded.mock.calls[0] as [string, string];

    expect(contents).not.toContain('a-passphrase-i-reuse-everywhere');
    expect(contents).toContain('Write your backup passphrase here');
  });
});
