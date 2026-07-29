import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const restore = vi.fn();
const maintenance = vi.fn();
vi.mock('../../../lib/backupClient', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/backupClient')>('../../../lib/backupClient');
  return {
    ...actual,
    restoreBackup: (input: unknown, onUpload?: (f: number) => void) => restore(input, onUpload),
    readMaintenance: () => maintenance(),
  };
});

import { RestoreWizard } from './RestoreWizard';
import { RestoreError } from '../../../lib/backupClient';
import type { RestoreReport } from '../../../api';

const PLAN: RestoreReport = {
  gatewayVersion: '1.3.2',
  createdAt: '2026-07-20T10:00:00.000Z',
  sourceEngine: 'postgres',
  rowsInFile: { nexusProvider: 4, tokenUsage: 1200 },
  totalRowsInFile: 1204,
  secretsInFile: 6,
  sourceSchema: null,
  missingEnv: [],
  schemaDrift: [],
  mode: 'merge',
  dryRun: true,
  written: {}, totalWritten: 0, skipped: {}, totalSkipped: 0,
  collisions: [],
  secretsRekeyed: 0, tablesCleared: 0, kvKeysCleared: 0,
};

const plan = (over: Partial<RestoreReport> = {}): RestoreReport => ({ ...PLAN, ...over });

/** A resolved handle, as backupClient would return once the gateway has answered. */
const answers = (report: RestoreReport) => ({ done: Promise.resolve(report), abort: vi.fn() });
const refuses = (error: unknown) => ({ done: Promise.reject(error), abort: vi.fn() });

beforeEach(() => {
  restore.mockReset();
  maintenance.mockReset();
  maintenance.mockResolvedValue({ active: false });
});

/** Put a file into the hidden input, the way the browser would after the Browse dialog. */
function pickFile(container: Element, name = 'nexus-backup.nxb'): void {
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'.repeat(2048)], name, { type: 'application/octet-stream' })],
  });
  fireEvent.change(input);
}

const typeInto = (placeholder: RegExp, value: string) =>
  fireEvent.input(screen.getByPlaceholderText(placeholder), { target: { value } });

/** Get to the report screen with a chosen file and a passphrase. */
async function check(container: Element, report: RestoreReport = PLAN): Promise<void> {
  pickFile(container);
  typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');
  restore.mockReturnValue(answers(report));
  fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));
  await screen.findByText(/what happens when you restore/i);
}

describe('the restore wizard', () => {
  it('offers no way to restore until the backup has been checked', async () => {
    // The dry run is what makes `replace` safe to offer at all: it authenticates the whole file and
    // writes nothing, so every question has an answer before anything is touched. A button that
    // skipped it would be a decision made with none of that on screen.
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');

    // A file is chosen and the passphrase is valid — everything a restore would need, and still
    // there is no restore to press.
    expect(screen.queryByRole('button', { name: /merge this backup in/i })).toBeNull();
    expect(screen.getByRole('button', { name: /check this backup/i })).toBeEnabled();

    // Not `check()`: the drop zone and its input are gone once a file is picked, so re-picking here
    // would be reaching for an element that is correctly absent.
    restore.mockReturnValue(answers(PLAN));
    fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));
    await screen.findByText(/what happens when you restore/i);

    expect(screen.getByRole('button', { name: /merge this backup in/i })).toBeInTheDocument();
  });

  it('will not check a file that has not been chosen', () => {
    render(<RestoreWizard />);
    expect(screen.getByRole('button', { name: /check this backup/i })).toBeDisabled();
  });

  it('refuses a passphrase too short to be one, before uploading anything', () => {
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'short');

    expect(screen.getByRole('button', { name: /check this backup/i })).toBeDisabled();
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
  });

  it('throws the report away when the passphrase changes under it', async () => {
    // A report describes ONE file, passphrase and mode. Left on screen after an edit it would be
    // accurate numbers about an operation nobody is proposing any more.
    const { container } = render(<RestoreWizard />);
    await check(container);

    typeInto(/passphrase for this file/i, 'a-different-passphrase');
    expect(screen.queryByText(/what happens when you restore/i)).toBeNull();
    expect(screen.getByRole('button', { name: /check this backup/i })).toBeInTheDocument();
  });

  it('throws the report away when the mode changes under it', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container);

    fireEvent.click(screen.getByRole('radio', { name: /Replace everything/i }));
    expect(screen.queryByText(/what happens when you restore/i)).toBeNull();
  });

  it('carries the row count from the check into the restore, so the bar has a denominator', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container);

    restore.mockReturnValue(answers(plan({ dryRun: false, totalWritten: 1204 })));
    fireEvent.click(screen.getByRole('button', { name: /merge this backup in/i }));

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(restore.mock.calls[1][0]).toMatchObject({ dryRun: false, mode: 'merge', expectedRows: 1204 });
  });
});

describe('replacing everything', () => {
  const reachReplaceConfirm = async () => {
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');
    fireEvent.click(screen.getByRole('radio', { name: /Replace everything/i }));
    restore.mockReturnValue(answers(plan({ mode: 'replace' })));
    fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));
    await screen.findByText(/what happens when you restore/i);
  };

  it('demands the master password and the typed phrase, exactly as the factory reset does', async () => {
    await reachReplaceConfirm();
    const go = screen.getByRole('button', { name: /replace everything with this backup/i });
    expect(go).toBeDisabled();

    fireEvent.input(screen.getByPlaceholderText('REPLACE ALL DATA'), { target: { value: 'REPLACE ALL DATA' } });
    expect(go).toBeDisabled();   // the phrase alone is not enough

    const master = screen.getByLabelText(/administrator master password/i);
    fireEvent.input(master, { target: { value: 'env-secret' } });
    expect(go).toBeEnabled();
  });

  it('is not satisfied by a near miss of the phrase', async () => {
    await reachReplaceConfirm();
    fireEvent.input(screen.getByPlaceholderText('REPLACE ALL DATA'), { target: { value: 'replace all data' } });
    fireEvent.input(screen.getByLabelText(/administrator master password/i), { target: { value: 'env-secret' } });

    expect(screen.getByRole('button', { name: /replace everything with this backup/i })).toBeDisabled();
  });

  it('says the restore signs everyone out, including the person doing it', async () => {
    await reachReplaceConfirm();
    expect(screen.getByText(/everyone is signed out, including you/i)).toBeInTheDocument();
  });
});

describe('what the report shows', () => {
  it('names the rows a merge would silently drop, and what that means', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container, plan({
      collisions: [{ model: 'nexusProvider', column: 'slug', count: 3, examples: ['openai', 'groq'] }],
    }));

    expect(screen.getByText(/3 rows would be skipped, not merged/i)).toBeInTheDocument();
    expect(screen.getByText('nexusProvider.slug')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });

  it('counts collisions on a hashed column without ever printing one', async () => {
    // The server sends no examples for a credential digest. The panel must not leave a bare count
    // looking like a rendering failure, so it says why the values are absent.
    const { container } = render(<RestoreWizard />);
    await check(container, plan({
      collisions: [{ model: 'nexusTeamKey', column: 'keyHash', count: 2, examples: [] }],
    }));

    expect(screen.getByText('nexusTeamKey.keyHash')).toBeInTheDocument();
    expect(screen.getByText(/hashed credentials, so the values are counted and never shown/i)).toBeInTheDocument();
  });

  it('lists settings the source gateway had that this one does not', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container, plan({ missingEnv: ['SSO_CLIENT_ID', 'SMTP_HOST'] }));

    expect(screen.getByText(/2 settings are missing from this server/i)).toBeInTheDocument();
    expect(screen.getByText('SSO_CLIENT_ID')).toBeInTheDocument();
    expect(screen.getByText(/quietly dead until you set them/i)).toBeInTheDocument();
  });

  it('shows absorbed schema drift as something handled, not something wrong', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container, plan({
      schemaDrift: [{ model: 'NexusKey', column: 'label', kind: 'missing-fillable', detail: 'added since; takes its default', blocking: false }],
    }));

    expect(screen.getByText(/nothing here stops the restore/i)).toBeInTheDocument();
    expect(screen.getByText('NexusKey.label')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing to flag', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container);
    expect(screen.getByText(/nothing to flag/i)).toBeInTheDocument();
  });

  it('names the engine a cross-engine restore is moving into', async () => {
    const { container } = render(<RestoreWizard targetEngine="sqlite" />);
    await check(container);
    expect(screen.getByText(/rows are re-written for this engine/i)).toBeInTheDocument();
  });
});

describe('when the gateway refuses', () => {
  it('keeps the file and shows the gateway’s own next step', async () => {
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');
    restore.mockReturnValue(refuses(new RestoreError(
      503, 'That restore ran out of time.', 'Nothing was changed. Raise NEXUS_RESTORE_TIMEOUT_MS and restore again — the file is fine.',
    )));
    fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));

    expect(await screen.findByText(/ran out of time/i)).toBeInTheDocument();
    expect(screen.getByText(/the file is fine/i)).toBeInTheDocument();
    // The chosen file survives a refusal — making someone re-pick a 900 MB backup to retry would be
    // a punishment for the gateway's problem.
    expect(screen.getByText('nexus-backup.nxb')).toBeInTheDocument();
  });

  it('lists the differences that blocked a restore rather than only naming the problem', async () => {
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');
    restore.mockReturnValue(refuses(new RestoreError(
      400, 'This backup cannot be restored onto this gateway.', 'Nothing was changed.',
      [
        { model: 'NexusKey', column: 'region', kind: 'unknown-column', detail: 'the file has a column this version does not', blocking: true },
        { model: 'NexusKey', column: 'label', kind: 'missing-fillable', detail: 'takes its default', blocking: false },
      ],
    )));
    fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));

    expect(await screen.findByText(/cannot be restored onto this gateway/i)).toBeInTheDocument();
    expect(screen.getByText('NexusKey.region')).toBeInTheDocument();
    // Only what actually blocked it — listing the absorbed drift here would pad the refusal with
    // differences that had nothing to do with it.
    expect(screen.queryByText('NexusKey.label')).toBeNull();
  });
});

describe('after a restore', () => {
  it('reports a merge with what it wrote and what it left alone', async () => {
    const { container } = render(<RestoreWizard />);
    await check(container);

    restore.mockReturnValue(answers(plan({
      dryRun: false, mode: 'merge', totalWritten: 1200, totalSkipped: 4, secretsRekeyed: 6,
    })));
    fireEvent.click(screen.getByRole('button', { name: /merge this backup in/i }));

    expect(await screen.findByText(/merged what was missing/i)).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();
    expect(screen.getByText(/left out/i)).toBeInTheDocument();
    // Nobody was signed out by a merge, so nothing here should suggest they were.
    expect(screen.queryByRole('button', { name: /sign in again/i })).toBeNull();
  });

  it('tells the operator they were signed out by their own replace', async () => {
    const { container } = render(<RestoreWizard />);
    pickFile(container);
    typeInto(/passphrase for this file/i, 'a-long-enough-passphrase');
    fireEvent.click(screen.getByRole('radio', { name: /Replace everything/i }));
    restore.mockReturnValue(answers(plan({ mode: 'replace' })));
    fireEvent.click(screen.getByRole('button', { name: /check this backup/i }));
    await screen.findByText(/what happens when you restore/i);

    fireEvent.input(screen.getByPlaceholderText('REPLACE ALL DATA'), { target: { value: 'REPLACE ALL DATA' } });
    fireEvent.input(screen.getByLabelText(/administrator master password/i), { target: { value: 'env-secret' } });
    restore.mockReturnValue(answers(plan({
      dryRun: false, mode: 'replace', totalWritten: 1204, tablesCleared: 16, kvKeysCleared: 42,
    })));
    fireEvent.click(screen.getByRole('button', { name: /replace everything with this backup/i }));

    expect(await screen.findByText(/this gateway is now the backup/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
    expect(screen.getByText(/sign in with an account from the backup you just restored/i)).toBeInTheDocument();
  });
});

describe('a restore already in flight', () => {
  it('shows it rather than an inviting empty form', async () => {
    // A reload mid-restore, or a second owner watching from their own browser. Offering "choose a
    // file" while the gateway is inside a transaction would invite a second one.
    maintenance.mockResolvedValue({
      active: true,
      maintenance: {
        reason: 'a backup is being restored', startedAt: Date.now(), rowsWritten: 5000,
        rowsExpected: 20000, updatedAt: Date.now(), elapsedMs: 9000, percent: 25,
        etaSeconds: 27, retryAfterSeconds: 30,
      },
    });
    render(<RestoreWizard />);

    expect(await screen.findByText(/a restore is already running/i)).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText(/about 27 seconds left/i)).toBeInTheDocument();
    expect(screen.queryByText(/drop a backup file here/i)).toBeNull();
  });
});
