/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { StoredBackup } from '../../../api';

const get = vi.fn();
const del = vi.fn();

vi.mock('../../../api', async () => {
  const actual = await vi.importActual<typeof import('../../../api')>('../../../api');
  return {
    ...actual,
    GET: (p: string) => get(p),
    DEL: (p: string) => del(p),
    getToken: () => 'the-session-token',
  };
});

import { BackupsList } from './BackupsList';

// The list that is the reason stored backups exist at all.
//
// Before it, a scheduled backup could only be retrieved by somebody with access to the server's
// filesystem — which on Railway, Render or Fly is nobody, so the feature produced files no human
// could ever reach. Everything here is about that last step actually working.
//
// ── Why the download is worth testing at this level ───────────────────────────────────────────
//
// It is not an <a href>, and it cannot be: the endpoint is owner-only and authenticated by a bearer
// token held in memory, and a browser navigation carries no Authorization header — it would arrive
// unauthenticated and answer 401. So the file is fetched with the header attached and handed over as
// a blob. That is four moving parts (fetch, header, object URL, revoke) standing between an operator
// and their only copy of the gateway, and none of them was checked.

const SCHEDULED: StoredBackup = {
  filename: 'alayra-nexus-backup-2026-08-01-04-00-00.nxb',
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  bytes: 4_200_000, rows: 18_314, origin: 'scheduled',
};

const MANUAL: StoredBackup = {
  filename: 'alayra-nexus-backup-2026-08-02-11-30-00.nxb',
  createdAt: new Date(Date.now() - 600_000).toISOString(),
  bytes: 4_300_000, rows: 18_402, origin: 'manual',
};

/**
 * The response shape `download` actually consumes — `ok`, `status`, `blob()` — and nothing else.
 *
 * A real `Response` carrying a real `Blob` does not survive the trip here: undici's Response and
 * jsdom's Blob are different implementations, and `res.blob()` rejects, which sends the component
 * down its error path and makes the whole download look broken for a reason that has nothing to do
 * with the component. Constructing exactly what is read keeps the test about the code under test.
 */
const ok = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
});

const refused = (status: number) => ({ ok: false, status, blob: async () => new Blob([]) });

let fetchMock: ReturnType<typeof vi.fn>;
let clickSpy: ReturnType<typeof vi.spyOn>;
let revoked: string[] = [];

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  revoked = [];

  get.mockResolvedValue({ backups: [MANUAL, SCHEDULED] });
  del.mockResolvedValue({});

  fetchMock = vi.fn(async () => ok());
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // jsdom implements neither. Without them the download path throws before it reaches anything this
  // file is trying to assert.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:nexus/the-object-url');
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });

  // Anchors are clicked for real here; jsdom would otherwise log an unimplemented navigation for
  // each one, which is noise rather than signal.
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => { clickSpy.mockRestore(); });

const downloadButtons = () => screen.getAllByRole('button', { name: /download/i });

describe('what the list shows', () => {
  it('tells an operator with no backups how to get one', async () => {
    get.mockResolvedValue({ backups: [] });
    render(<BackupsList refreshToken={0} />);

    expect(await screen.findByText('No backups yet')).toBeInTheDocument();
    // An empty state that only says "empty" leaves somebody looking for the feature. This one names
    // both routes to a first backup.
    expect(screen.getByText(/Switch the schedule on below/i)).toBeInTheDocument();
    expect(screen.getByText('Back up now')).toBeInTheDocument();
  });

  it('says which backups the schedule took and which somebody took by hand', async () => {
    render(<BackupsList refreshToken={0} />);

    expect(await screen.findByText(MANUAL.filename)).toBeInTheDocument();
    expect(screen.getByText(SCHEDULED.filename)).toBeInTheDocument();

    // `origin` exists to answer "did the schedule actually fire, or is every backup here one I took
    // myself?" — a question an operator cannot otherwise answer, and the whole reason the column is
    // stored. Rendering both the same way would throw that away at the last step.
    expect(screen.getByText(/Taken by hand/)).toBeInTheDocument();
    expect(screen.getByText(/On schedule/)).toBeInTheDocument();

    expect(screen.getByText('2 backups')).toBeInTheDocument();
  });

  it('reports a list it could not read, rather than showing an empty one', async () => {
    // These must never look alike. "No backups yet" on a gateway that has plenty is the single most
    // dangerous thing this component could render — it is the screen somebody checks before doing
    // something irreversible.
    get.mockRejectedValue(new Error('The gateway is not answering.'));
    render(<BackupsList refreshToken={0} />);

    expect(await screen.findByText('The gateway is not answering.')).toBeInTheDocument();
    expect(screen.queryByText('No backups yet')).toBeInTheDocument();
  });
});

describe('getting one onto the operator’s own machine', () => {
  it('sends the session token, which a plain link could never do', async () => {
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(downloadButtons()[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`/admin/backup/archive/${encodeURIComponent(MANUAL.filename)}`);
    // The reason this is a fetch and not an <a href>. Without the header the route answers 401 and
    // the operator concludes their backups are unreachable.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-session-token');
  });

  it('releases the object URL, or every download leaks the whole file for the life of the tab', async () => {
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(downloadButtons()[0]);

    await waitFor(() => expect(revoked).toEqual(['blob:nexus/the-object-url']));
    // A backup is the largest thing this app ever holds. Downloading a few of them without this
    // pins hundreds of megabytes until the tab is closed.
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('says so when the gateway refuses, and lets the operator try again', async () => {
    fetchMock.mockResolvedValue(refused(403));
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(downloadButtons()[0]);

    expect(await screen.findByText(/would not release that backup \(403\)/)).toBeInTheDocument();
    // And the row is usable again. A failed download that leaves every button disabled is a dead
    // panel, recoverable only by a reload nobody knows to do.
    await waitFor(() => expect(downloadButtons()[0]).not.toBeDisabled());
  });
});

describe('deleting one', () => {
  it('asks the gateway, then stops showing it', async () => {
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${MANUAL.filename}` }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(
      `/admin/backup/archive/${encodeURIComponent(MANUAL.filename)}`,
    ));
    await waitFor(() => expect(screen.queryByText(MANUAL.filename)).toBeNull());
    // Only that one. A list that re-read itself and dropped the wrong row would still look right.
    expect(screen.getByText(SCHEDULED.filename)).toBeInTheDocument();
  });

  it('keeps the backup on screen when the gateway refused to delete it', async () => {
    del.mockRejectedValue(new Error('That backup is being written to.'));
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${MANUAL.filename}` }));

    expect(await screen.findByText('That backup is being written to.')).toBeInTheDocument();
    // Removing it optimistically and leaving it removed would tell the operator a backup is gone
    // while it is still sitting in the database — the mirror image of the empty-list problem above.
    expect(screen.getByText(MANUAL.filename)).toBeInTheDocument();
  });

  it('disables every button while one row is working', async () => {
    // Deliberately never resolves, so the busy state can be observed rather than raced.
    del.mockReturnValue(new Promise(() => {}));
    render(<BackupsList refreshToken={0} />);
    await screen.findByText(MANUAL.filename);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${MANUAL.filename}` }));

    // Every one, not merely the row that was clicked: these actions destroy things, and a second
    // click landing on a different row during the first is the way somebody deletes a backup they
    // never meant to touch.
    await waitFor(() => {
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    });
  });
});
