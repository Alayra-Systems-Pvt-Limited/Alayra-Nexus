/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import type { BackupScheduleOverview } from '../../../api';
import { DataLossNotice } from './DataLossNotice';

// The loudest thing in the product, and until now the only part of it nothing checked.
//
// ── Why this needs its own test rather than a browser one ─────────────────────────────────────
//
// Two of the four states cannot be reached end to end. `off-machine` needs an object-storage
// destination, which is B3 and has not shipped — so the ONLY green state the notice can ever show is
// unreachable by a running gateway today, and a browser test would leave it permanently unverified.
// `copy-failing` needs a copy that ran and failed, which is a real 3am event rather than something a
// page can be driven into.
//
// ── What is actually being checked ────────────────────────────────────────────────────────────
//
// Not the words. The DECISIONS: which state wins, what a folder does and does not earn, and which
// destination gets named when two disagree. Each of those is a product judgement that took a
// paragraph of reasoning to reach, and each is one line away from being quietly reversed.

const overview = (patch: {
  copyOffMachine?: boolean;
  kind?: string;
  path?: string;
  lastCopyOutcome?: 'ok' | 'failed' | null;
  lastCopyError?: string | null;
  lastCopyDestination?: string | null;
} = {}): BackupScheduleOverview => ({
  schedule: {
    enabled: true, everyDays: 1, hourUtc: 4, minuteUtc: 0, keep: 7,
    copyOffMachine: patch.copyOffMachine ?? false,
    // `kind` is a literal type today because 'directory' is the only destination that exists. The
    // cast is what lets this file test the green state at all — see the note at the top.
    destination: {
      kind: (patch.kind ?? 'directory') as 'directory',
      path: patch.path ?? '/var/backups/nexus',
    },
  },
  state: {
    lastRunAt: null, lastOutcome: null, lastError: null,
    lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null,
    lastCopyOutcome: patch.lastCopyOutcome ?? null,
    lastCopyError: patch.lastCopyError ?? null,
    lastCopyDestination: patch.lastCopyDestination ?? null,
  },
  nextRunAt: null, dueNow: false, hasRecoveryKey: true, storedBytes: 0,
});

describe('nothing has been done about it', () => {
  it('says plainly, and in an alert, that the backups die with the database', () => {
    render(<DataLossNotice overview={overview()} />);

    const box = screen.getByRole('alert');
    // `alert` rather than `note`: a screen reader has to announce this one without being asked. It
    // is the difference between a warning and a decoration.
    expect(box).toHaveTextContent('Download these');
    expect(box).toHaveTextContent(/no second copy on our side/i);

    // And it names the way out, in the words of the control that provides it. A warning that only
    // frightens is a warning people learn to close.
    expect(box).toHaveTextContent('Keep a copy off this machine');
  });
});

describe('a folder is configured', () => {
  it('does NOT clear the warning — a folder proves somebody typed a path, not that anything is safe', () => {
    render(<DataLossNotice overview={overview({ copyOffMachine: true })} />);

    // The decision this whole component turns on. A folder is durable on a VM and erased on every
    // redeploy inside a container, and the gateway cannot tell which it is running in. Silence here
    // would be hiding a true warning on a signal that proves nothing — so it de-escalates to a note
    // and keeps saying the part that is still unresolved.
    expect(screen.queryByRole('alert')).toBeNull();
    const box = screen.getByRole('note');
    expect(box).toHaveTextContent('/var/backups/nexus');
    expect(box).toHaveTextContent(/only as safe as the machine it sits on/i);
    expect(box).toHaveTextContent(/container without a mounted volume/i);
  });

  it('stays a note even though no copy has ever actually run', () => {
    // Nothing has been proven yet, so this must not read as an achievement — but it must not be red
    // either, because the operator HAS acted. The wording carries that: it describes what is being
    // written, not a copy that already exists.
    render(<DataLossNotice overview={overview({ copyOffMachine: true, lastCopyOutcome: null })} />);
    expect(screen.getByRole('note')).toHaveTextContent(/A second copy is being written to/i);
  });
});

describe('the copy is configured and failing', () => {
  it('goes back to red, because believing you are covered is worse than knowing you are not', () => {
    render(<DataLossNotice overview={overview({
      copyOffMachine: true, lastCopyOutcome: 'failed',
      lastCopyError: 'Could not use /mnt/nas for backups: ENOENT',
    })} />);

    const box = screen.getByRole('alert');
    // The gateway's own words, not a paraphrase. The operator has to fix a specific thing, and only
    // the original message says which.
    expect(box).toHaveTextContent('Could not use /mnt/nas for backups: ENOENT');

    // And the distinction that stops this becoming a panic: the BACKUPS are fine. Reporting a failed
    // copy as a failed backup would send somebody looking for a file that is sitting right there.
    expect(box).toHaveTextContent(/backups themselves were\s+taken and can still be downloaded/i);
    expect(box).toHaveTextContent(/it is the second copy that is missing/i);
  });

  it('outranks the destination being configured at all', () => {
    // A configured directory would otherwise land in the amber state. Failure has to win, or the
    // most dangerous situation in the whole component renders as reassurance.
    render(<DataLossNotice overview={overview({ copyOffMachine: true, lastCopyOutcome: 'failed' })} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('still says something useful when the gateway could not explain itself', () => {
    render(<DataLossNotice overview={overview({ copyOffMachine: true, lastCopyOutcome: 'failed' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The gateway did not say why.');
  });
});

describe('the copy is genuinely off this machine', () => {
  it('is the only state that stops warning, and it needs a destination that is not a folder', () => {
    render(<DataLossNotice overview={overview({
      copyOffMachine: true, kind: 's3', path: 's3://acme-backups/nexus',
    })} />);

    // `status`, not `alert`: this is confirmation, and announcing it as urgently as a data-loss
    // warning is how the colour stops meaning anything.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/survive losing the gateway and its database/i);
  });
});

describe('which destination gets named', () => {
  it('prefers where the copy actually went over where it was configured to go', () => {
    // These disagree exactly when somebody edited the destination after the last run — the moment
    // naming the wrong one is most misleading, because the operator is checking whether their change
    // took effect. The notice reports the observed fact, not the intention.
    render(<DataLossNotice overview={overview({
      copyOffMachine: true, path: '/new/path/typed/just/now',
      lastCopyDestination: '/where/it/actually/went',
    })} />);

    const box = screen.getByRole('note');
    expect(box).toHaveTextContent('/where/it/actually/went');
    expect(box).not.toHaveTextContent('/new/path/typed/just/now');
  });

  it('falls back to the configured path when no copy has run yet', () => {
    render(<DataLossNotice overview={overview({ copyOffMachine: true, path: '/var/backups/nexus' })} />);
    expect(screen.getByRole('note')).toHaveTextContent('/var/backups/nexus');
  });
});
