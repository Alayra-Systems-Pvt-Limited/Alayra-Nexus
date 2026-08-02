/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { MigrateTargetReport, MigrateOutcome } from '../../../api';

const post = vi.fn();

vi.mock('../../../api', async () => {
  const actual = await vi.importActual<typeof import('../../../api')>('../../../api');
  return { ...actual, POST: (p: string, b?: unknown) => post(p, b) };
});

import { MoveToPostgres } from './MoveToPostgres';

// The screen an operator meets at the moment they decide whether to trust this with their data.
//
// ── Why this is covered here and not end to end ───────────────────────────────────────────────
//
// Both e2e stacks run on PostgreSQL, so a browser can only ever reach the one sentence that says
// there is nothing to move — `migrateToPostgres` refuses outright on a gateway that is already
// there. Driving the actual wizard would need a third standalone stack existing solely for this
// screen, which is a lot of machinery for a form. What the move DOES is already proven for real by
// `migrateCopy.parity.test.ts`, against two live engines. What was never checked is this: whether a
// person can get through the screen, and whether what it tells them is true.
//
// ── The two properties worth the most ─────────────────────────────────────────────────────────
//
// That a verdict cannot outlive the connection string it was about, and that a dropped connection is
// never reported as "nothing happened". Both are the sort of thing that reads as a detail and
// behaves as data loss.

const CONNECTION = 'postgresql://someone:hunter2@db.example.com:5432/nexus';

const report = (patch: Partial<MigrateTargetReport> = {}): MigrateTargetReport => ({
  reachable: true, version: 'PostgreSQL 16.4 on x86_64-pc-linux-gnu, compiled by gcc',
  occupied: [], describes: 'db.example.com:5432/nexus', problem: null, ...patch,
});

const outcome = (patch: Partial<MigrateOutcome> = {}): MigrateOutcome => ({
  ok: true, target: 'db.example.com:5432/nexus', rowsCopied: 18_402,
  notMigrated: ['backup', 'backupChunk'], mismatches: [], ...patch,
});

const NOT_MIGRATED = ['backup', 'backupChunk'];

const urlBox = () => screen.getByPlaceholderText('postgresql://user:password@host:5432/nexus');
const checkButton = () => screen.getByRole('button', { name: /Check this database/i });
const moveButton = () => screen.queryByRole('button', { name: /Move my data/i });

/** Type a connection string and run the check, leaving the component in `checked`. */
async function checkWith(r: MigrateTargetReport) {
  post.mockResolvedValueOnce(r);
  fireEvent.input(urlBox(), { target: { value: CONNECTION } });
  fireEvent.click(checkButton());
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/migrate/inspect', { url: CONNECTION }));
}

beforeEach(() => { post.mockReset(); });

describe('looking before moving', () => {
  it('will not check nothing', () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    expect(checkButton()).toBeDisabled();
  });

  it('offers no way to move until a check has come back usable', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);

    fireEvent.input(urlBox(), { target: { value: CONNECTION } });
    // The whole shape of this screen: everything knowable without touching the destination is
    // learned and shown first, and only then is the frightening thing offered.
    expect(moveButton()).toBeNull();

    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());
  });

  it('withdraws the verdict the moment the connection string changes', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());

    fireEvent.input(urlBox(), { target: { value: `${CONNECTION}_other` } });

    // The most dangerous state this component could hold: a green "ready" verdict describing one
    // database while the box names a different one. The operator would then press Move having been
    // reassured about somewhere else entirely.
    expect(moveButton()).toBeNull();
    expect(screen.queryByText(/is ready/i)).toBeNull();
  });
});

describe('what the check found', () => {
  it('reports a database it could not reach, in the gateway’s own words', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report({ reachable: false, problem: 'getaddrinfo ENOTFOUND db.example.com' }));

    const box = await screen.findByRole('alert');
    expect(box).toHaveTextContent('could not be reached');
    // Verbatim, because the operator has to fix one specific thing and only the original says which.
    expect(box).toHaveTextContent('getaddrinfo ENOTFOUND db.example.com');
    expect(moveButton()).toBeNull();
  });

  it('refuses a database that already holds a gateway, and names what is in it', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report({ occupied: ['NexusProvider', 'TokenUsage'] }));

    const box = await screen.findByRole('alert');
    expect(box).toHaveTextContent('already in use');
    // Naming the tables is what turns "refused" into "that is my other gateway, of course".
    expect(box).toHaveTextContent('NexusProvider, TokenUsage');
    expect(box).toHaveTextContent(/two\s+gateways' records in one database/i);
    expect(moveButton()).toBeNull();
  });

  it('confirms an empty one, and says what it is', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());

    const box = await screen.findByRole('status');
    expect(box).toHaveTextContent('db.example.com:5432/nexus is ready');
    // Trimmed to the first two words: an operator wants "PostgreSQL 16.4", not the compiler it was
    // built with.
    expect(box).toHaveTextContent('PostgreSQL 16.4');
    expect(box).not.toHaveTextContent('gcc');

    // The reassurance appears only once there is something to be reassured about.
    expect(screen.getByText(/Nothing is deleted and nothing switches over/i)).toBeInTheDocument();
  });
});

describe('the connection string is a password', () => {
  it('is never echoed back anywhere on the page', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await screen.findByRole('status');

    // The server answers with host and database only, and every result renders THAT. If the typed
    // string reached the page, the operator's database password would be sitting in the DOM — and in
    // any screenshot they send when asking for help.
    expect(document.body.textContent).not.toContain('hunter2');
    expect(document.body.textContent).not.toContain(CONNECTION);
  });

  it('is masked in the field itself', () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    expect(urlBox()).toHaveAttribute('type', 'password');
  });
});

describe('while it runs, and after', () => {
  it('says not to close the page, and explains the silence', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());

    post.mockReturnValueOnce(new Promise(() => {}));  // never settles: the moving state, observed
    fireEvent.click(moveButton()!);

    // Reached through its text rather than by role: the block carries `role="status"` and so does
    // the Spinner inside it, so asking for the role alone is ambiguous.
    const busy = (await screen.findByText(/Do not close this page/i)).closest('[role="status"]')!;
    // The gateway is refusing traffic at this moment, and an operator watching their requests fail
    // needs to know that is deliberate and temporary.
    expect(busy).toHaveTextContent(/refusing requests while this runs/i);
    expect(urlBox()).toBeDisabled();
  });

  it('reports a finished move, what stayed behind, and the one step that follows', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());

    post.mockResolvedValueOnce(outcome());
    fireEvent.click(moveButton()!);

    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent('18,402 rows are now in db.example.com:5432/nexus');
    // Named before anyone has to discover it. A migration that silently dropped backup history would
    // be found at the worst possible moment.
    expect(done).toHaveTextContent('backup, backupChunk');
    expect(screen.getByText(/set/)).toBeInTheDocument();
    expect(done).toHaveTextContent(/you are still running on the old one/i);
  });

  it('lists the tables that disagree when the counts do not match', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());

    post.mockResolvedValueOnce(outcome({
      ok: false, error: 'The move finished but the row counts do not match.',
      mismatches: [{ model: 'tokenUsage', source: 1_201, target: 1_199 }],
    }));
    fireEvent.click(moveButton()!);

    const box = await screen.findByRole('alert');
    expect(box).toHaveTextContent('The move did not finish');
    // The specific number, on the specific table. "Counts do not match" alone leaves somebody with
    // no idea whether they lost two rows or half a database.
    expect(box).toHaveTextContent('1,201 here, 1,199 there');
    expect(box).toHaveTextContent(/This gateway is untouched/i);
  });

  it('never reports a dropped connection as “it did not happen”', async () => {
    render(<MoveToPostgres notMigrated={NOT_MIGRATED} />);
    await checkWith(report());
    await waitFor(() => expect(moveButton()).not.toBeNull());

    post.mockRejectedValueOnce(new Error('Failed to fetch.'));
    fireEvent.click(moveButton()!);

    // Genuinely ambiguous: the move may have completed after the socket went away. Telling somebody
    // it failed invites them to run it again into a database that is now full, which is the one
    // thing the occupied-check exists to prevent them from doing by accident.
    expect(await screen.findByText(/The move may still have finished/i)).toBeInTheDocument();

    // And they are put back where they can act, rather than left on a dead screen.
    await waitFor(() => expect(moveButton()).not.toBeNull());
  });
});
