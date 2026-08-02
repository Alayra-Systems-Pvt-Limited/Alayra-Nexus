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
import { render, screen } from '@testing-library/preact';
import type { MigrateStatus } from '../../../api';

const get = vi.fn();

vi.mock('../../../api', async () => {
  const actual = await vi.importActual<typeof import('../../../api')>('../../../api');
  return { ...actual, GET: (p: string) => get(p) };
});

import { DatabasePanel } from './DatabasePanel';

// Which of two quite different screens an operator is shown, decided by one field.
//
// The gateway that CAN move is offered a form that will copy its entire database somewhere else. The
// gateway that cannot must not be — and, just as deliberately, must not be shown an empty tab and
// left wondering where the option went. Getting that backwards in either direction is the only way
// this panel can be wrong, and it is one boolean.

const status = (patch: Partial<MigrateStatus> = {}): MigrateStatus => ({
  engine: 'sqlite', canMigrate: true, notMigrated: ['backup', 'backupChunk'], ...patch,
});

const connectionBox = () => screen.queryByPlaceholderText('postgresql://user:password@host:5432/nexus');

beforeEach(() => { get.mockReset(); });

describe('a gateway running on a single file', () => {
  it('is told what that costs, and offered the move', async () => {
    get.mockResolvedValue(status());
    render(<DatabasePanel />);

    expect(await screen.findByText('Single file')).toBeInTheDocument();
    // The reason to move, stated as the specific thing that goes wrong rather than as a
    // recommendation: a file is durable as long as the machine is, and a container is not a machine.
    expect(screen.getByText(/does not survive a container being replaced/i)).toBeInTheDocument();
    expect(connectionBox()).not.toBeNull();
  });
});

describe('a gateway already on PostgreSQL', () => {
  it('is told there is nothing to move, rather than shown an empty tab', async () => {
    get.mockResolvedValue(status({ engine: 'postgres', canMigrate: false }));
    render(<DatabasePanel />);

    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText(/already runs on PostgreSQL, so there is nothing to move/i))
      .toBeInTheDocument();
  });

  it('is not offered a form that would refuse it anyway', async () => {
    // `migrateToPostgres` rejects a gateway that is already on Postgres before doing anything else.
    // Rendering the form regardless would invite somebody to paste a production connection string
    // into a box whose only possible answer is a refusal.
    get.mockResolvedValue(status({ engine: 'postgres', canMigrate: false }));
    render(<DatabasePanel />);

    await screen.findByText('PostgreSQL');
    expect(connectionBox()).toBeNull();
  });
});

describe('when the gateway will not say', () => {
  it('reports it, instead of quietly looking like a gateway with nothing to offer', async () => {
    // The failure mode worth avoiding: `status` stays null, both blocks below are skipped, and the
    // panel renders a heading over nothing at all — indistinguishable from a considered decision
    // that there was nothing to show.
    get.mockRejectedValue(new Error('Not signed in.'));
    render(<DatabasePanel />);

    expect(await screen.findByText('Not signed in.')).toBeInTheDocument();
    expect(screen.queryByText(/Checking which database/i)).toBeNull();
    expect(connectionBox()).toBeNull();
  });
});
