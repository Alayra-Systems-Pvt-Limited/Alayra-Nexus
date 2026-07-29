import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const download = vi.fn();
vi.mock('../../../lib/backupClient', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/backupClient')>('../../../lib/backupClient');
  return { ...actual, downloadBackup: (p: string, g: boolean) => download(p, g) };
});

import { ExportCard } from './ExportCard';
import { RestoreError } from '../../../lib/backupClient';

const GOOD = 'a-passphrase-i-will-remember';

beforeEach(() => {
  download.mockReset();
  download.mockResolvedValue('nexus-backup-2026-07-29.nxb');
});

const fill = (placeholder: RegExp, value: string) =>
  fireEvent.input(screen.getByPlaceholderText(placeholder), { target: { value } });

const button = () => screen.getByRole('button', { name: /download backup/i });

describe('taking a backup', () => {
  it('will not write one under a passphrase the gateway would refuse', () => {
    render(<ExportCard />);
    fill(/still have in a year/i, 'short');

    expect(button()).toBeDisabled();
    // Counts down rather than restating the rule: the field's own hint already says "at least 12",
    // and repeating it teaches nothing at the moment someone is typing.
    expect(screen.getByText(/Use at least 12 characters — 7 to go/)).toBeInTheDocument();
  });

  it('will not write one under a passphrase that was typed differently twice', async () => {
    // Nothing later in the system can catch this. The gateway keeps no copy of the passphrase, so a
    // typo here produces a file that simply never opens — and the discovery comes on the day it is
    // needed. The second field is the only place this is catchable at all.
    render(<ExportCard />);
    fill(/still have in a year/i, GOOD);
    fill(/confirm the passphrase/i, `${GOOD}x`);

    expect(button()).toBeDisabled();
    expect(screen.getByText(/don’t match/i)).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });

  it('writes the backup once both fields agree', async () => {
    render(<ExportCard />);
    fill(/still have in a year/i, GOOD);
    fill(/confirm the passphrase/i, GOOD);
    fireEvent.click(button());

    await waitFor(() => expect(download).toHaveBeenCalledWith(GOOD, false));
    expect(await screen.findByText('nexus-backup-2026-07-29.nxb')).toBeInTheDocument();
  });

  it('defaults to a file this gateway cannot open by itself, and passes the choice through', async () => {
    // Off is the right default for a file being downloaded: a second way in only helps someone who
    // already holds the server's environment, and the file is the thing leaving the building.
    render(<ExportCard />);
    const toggle = screen.getByRole('switch', { name: /without the passphrase/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    fill(/still have in a year/i, GOOD);
    fill(/confirm the passphrase/i, GOOD);
    fireEvent.click(button());

    await waitFor(() => expect(download).toHaveBeenCalledWith(GOOD, true));
  });

  it('clears the passphrase after a successful download, so it is not left on screen', async () => {
    render(<ExportCard />);
    fill(/still have in a year/i, GOOD);
    fill(/confirm the passphrase/i, GOOD);
    fireEvent.click(button());

    await screen.findByText('nexus-backup-2026-07-29.nxb');
    expect(screen.getByPlaceholderText(/still have in a year/i)).toHaveValue('');
  });

  it('shows the gateway’s reason and its next step when the file cannot be written', async () => {
    download.mockRejectedValue(new RestoreError(
      0, 'The download was cut short, so the backup is incomplete.',
      'Nothing was saved. A partial backup cannot be restored — take another one.',
    ));
    render(<ExportCard />);
    fill(/still have in a year/i, GOOD);
    fill(/confirm the passphrase/i, GOOD);
    fireEvent.click(button());

    expect(await screen.findByText(/cut short.*Nothing was saved/i)).toBeInTheDocument();
    // The form is usable again: a failure here is not a reason to make someone reload the page.
    expect(button()).toBeEnabled();
  });
});
