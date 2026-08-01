import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { BackupScheduleOverview } from '../../../api';

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();

vi.mock('../../../api', async () => {
  const actual = await vi.importActual<typeof import('../../../api')>('../../../api');
  return {
    ...actual,
    GET:  (p: string) => get(p),
    PUT:  (p: string, b?: unknown) => put(p, b),
    POST: (p: string, b?: unknown) => post(p, b),
  };
});

import { ScheduleCard } from './ScheduleCard';

const NOW = Date.now();

const overview = (patch: Partial<BackupScheduleOverview> = {}): BackupScheduleOverview => ({
  schedule: {
    enabled: true, everyDays: 1, hourUtc: 4, minuteUtc: 0, keep: 7,
    copyOffMachine: true,
    destination: { kind: 'directory', path: '/var/backups/nexus' },
  },
  state: {
    lastRunAt: NOW - 3_600_000, lastOutcome: 'ok', lastError: null,
    lastFilename: 'alayra-nexus-backup-2026-08-01-04-00-00.nxb',
    lastBytes: 4_200_000, lastRows: 18_314, lastPruned: 1, lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null,
  },
  // Thirty seconds of slack past the minute. The card floors the countdown, and the gap between
  // this module loading and the component reading its own clock is real — without the slack the
  // assertion below would read "in 6h 11m" on a slow run.
  nextRunAt: new Date(NOW + 6 * 3_600_000 + 12 * 60_000 + 30_000).toISOString(),
  dueNow: false,
  hasRecoveryKey: true,
  storedBytes: 0,
  ...patch,
});

beforeEach(() => {
  get.mockReset(); put.mockReset(); post.mockReset();
  get.mockResolvedValue(overview());
});

const saveButton = () => screen.getByRole('button', { name: /save schedule/i });
const runButton  = () => screen.getByRole('button', { name: /back up now/i });

describe('the scheduled-backup card', () => {
  it('reports what the gateway is actually doing, not what was configured', async () => {
    render(<ScheduleCard version={0} onChanged={() => {}} />);

    // The last run, the next one, and where the files go — the three facts that answer "is this
    // working". A card that only showed the form would answer none of them.
    expect(await screen.findByText(/alayra-nexus-backup-2026-08-01-04-00-00\.nxb/)).toBeInTheDocument();
    expect(screen.getByText(/in 6h 12m/)).toBeInTheDocument();
    // Twice on purpose: once in the sentence that reads the settings back, once in the state strip
    // that answers "where are the files".
    expect(screen.getAllByText('/var/backups/nexus')).toHaveLength(2);
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('says a schedule has never run rather than showing nothing', async () => {
    // An absence of good news is not news. "Never" is a fact an operator can act on; a blank space
    // is one they will read as "fine".
    get.mockResolvedValue(overview({
      state: { lastRunAt: null, lastOutcome: null, lastError: null, lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null,
        lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null },
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);

    expect(await screen.findByText('Never')).toBeInTheDocument();
  });

  it('says a run is due now rather than naming the window after it', async () => {
    // Found by watching a real gateway: switching the schedule on makes a backup due IMMEDIATELY,
    // and `nextRunAt` is strictly after now — so the card promised "in 6h 12m" and a file appeared
    // thirty seconds later. Both facts were true; leading with the wrong one teaches an operator
    // that this panel does not know what the gateway is doing.
    get.mockResolvedValue(overview({
      dueNow: true,
      state: { lastRunAt: null, lastOutcome: null, lastError: null, lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null,
        lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null },
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);

    expect(await screen.findByText('Due now')).toBeInTheDocument();
    expect(screen.getByText(/within a minute/)).toBeInTheDocument();
    expect(screen.queryByText(/in 6h 12m/)).not.toBeInTheDocument();
  });

  it('leads with a failed run, in the gateway’s own words, and says older backups were kept', async () => {
    get.mockResolvedValue(overview({
      state: {
        lastRunAt: NOW - 7_200_000, lastOutcome: 'failed',
        lastError: 'Could not use /var/backups/nexus for backups: EACCES: permission denied',
        lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null, lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null,
      },
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);

    expect(await screen.findByText(/EACCES: permission denied/)).toBeInTheDocument();
    expect(screen.getByText(/older backups were left alone/i)).toBeInTheDocument();
    // A green "On" above a red failure would be a lie told by the more prominent of the two.
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  it('will not let the schedule be switched on without a recovery key, and says why', async () => {
    // Such a backup carries no passphrase, so the recovery key is the only thing that could ever
    // open it — a file readable solely by the machine it exists to survive.
    get.mockResolvedValue(overview({
      schedule: { ...overview().schedule, enabled: false },
      hasRecoveryKey: false,
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);

    expect(await screen.findByText(/no recovery key/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /on a schedule/i })).toBeDisabled();
  });

  it('refuses a relative folder before the gateway has to, and blocks the save', async () => {
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.input(screen.getByPlaceholderText('/var/backups/alayra-nexus'), { target: { value: 'backups' } });

    // Matched on the half of the sentence the field's own hint does not also say, so this asserts
    // the refusal appeared rather than that the form is still on screen.
    expect(screen.getByText(/starting from the root of the disk/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });

  it('sends the whole schedule on save and adopts what comes back', async () => {
    const saved = overview({ schedule: { ...overview().schedule, keep: 30 } });
    put.mockResolvedValue(saved);
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    expect(saveButton()).toBeDisabled();                      // nothing has changed yet
    fireEvent.change(screen.getByLabelText(/^Keep$/i), { target: { value: '30' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/backup/schedule', {
      enabled: true, everyDays: 1, hourUtc: 4, minuteUtc: 0, keep: 30,
      copyOffMachine: true,
      destination: { kind: 'directory', path: '/var/backups/nexus' },
    }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    // Adopted, not refetched: the response IS the new state, and a second GET could race it.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('shows the gateway’s refusal verbatim', async () => {
    // The server's messages here are already written for an operator — a missing recovery key, a
    // relative path. Rewording them into something vaguer would lose the next step.
    put.mockRejectedValue(new Error('This gateway has no recovery key, so an unattended backup could only ever be opened by this same server.'));
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.change(screen.getByLabelText(/^Keep$/i), { target: { value: '14' } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(/no recovery key, so an unattended backup/)).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();   // a refusal is not a reason to make someone reload
  });

  it('will not back up now while the folder on screen is not the folder that would be used', async () => {
    // "Back up now" runs the SAVED schedule. Offering it over an edited path would write the file
    // somewhere the operator has stopped looking, and report success.
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.input(screen.getByPlaceholderText('/var/backups/alayra-nexus'), { target: { value: '/mnt/elsewhere' } });

    expect(runButton()).toBeDisabled();
    expect(screen.getByText(/uses the/i)).toBeInTheDocument();
  });

  it('offers “Back up now” on a gateway that has been given no folder at all', async () => {
    // The state a fresh install is in, and the regression this whole redesign exists to fix. The
    // button used to be withdrawn until somebody typed a path — on a hosted platform with no disk,
    // that meant it could never be pressed at all. The gateway now always has somewhere to put a
    // backup, so the button always works.
    get.mockResolvedValue(overview({
      schedule: {
        ...overview().schedule, enabled: false,
        copyOffMachine: false, destination: { kind: 'directory', path: '' },
      },
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByRole('button', { name: /back up now/i });

    expect(runButton()).not.toBeDisabled();
    expect(screen.queryByText(/needs a folder to write into/i)).not.toBeInTheDocument();
  });

  it('takes one on demand and says the schedule will not take a second tonight', async () => {
    post.mockResolvedValue({
      ...overview(), ran: true,
      filename: 'alayra-nexus-backup-2026-08-01-11-30-00.nxb', bytes: 4_300_000, rows: 18_402, pruned: 0,
    });
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.click(runButton());

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/backup/schedule/run', undefined));
    expect(await screen.findByText(/alayra-nexus-backup-2026-08-01-11-30-00\.nxb/)).toBeInTheDocument();
    expect(screen.getByText(/will not take a\s+second one tonight/i)).toBeInTheDocument();
  });

  it('re-reads the schedule after a failed run, so the strip does not contradict the error', async () => {
    // A failed run is stamped server-side whether it worked or not. Leaving the strip on the
    // previous success would read as though the failure had not counted.
    post.mockRejectedValue(new Error('Could not use /var/backups/nexus for backups: EACCES: permission denied'));
    get.mockResolvedValueOnce(overview()).mockResolvedValueOnce(overview({
      state: {
        lastRunAt: NOW, lastOutcome: 'failed',
        lastError: 'Could not use /var/backups/nexus for backups: EACCES: permission denied',
        lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null, lastCopyOutcome: null, lastCopyError: null, lastCopyDestination: null,
      },
    }));
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.click(runButton());

    expect(await screen.findByText('Failing')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reverts a draft without touching the gateway', async () => {
    render(<ScheduleCard version={0} onChanged={() => {}} />);
    await screen.findByText('On');

    fireEvent.input(screen.getByPlaceholderText('/var/backups/alayra-nexus'), { target: { value: '/mnt/elsewhere' } });
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));

    expect(screen.getByPlaceholderText('/var/backups/alayra-nexus')).toHaveValue('/var/backups/nexus');
    expect(saveButton()).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });
});
