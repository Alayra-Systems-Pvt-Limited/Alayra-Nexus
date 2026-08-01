/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// What the dashboard is told about the schedule.
//
// The decisions themselves live in lib/backupSchedule and are tested there against arguments alone.
// This covers the one thing that layer cannot: assembling those answers into the shape the panel
// renders, and specifically NOT leaving out the urgent half.

const { settings, recovery, stored } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  recovery: { present: true },
  stored: [] as { id: string; filename: string; createdAt: Date; bytes: number; rows: number; origin: string }[],
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    appSettings: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        settings.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
    // The overview reports how much space stored backups occupy, so the table has to exist here
    // even for the tests that only care about scheduling.
    backup: {
      findMany: async () => [...stored],
      create: async () => ({ id: 'stored-1' }),
      update: async () => ({}),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      findUnique: async () => null,
    },
    backupChunk: { create: async () => ({}), findMany: async () => [] },
  },
}));

vi.mock('../lib/redis', () => ({ redis: { set: async () => 'OK', get: async () => null, del: async () => 1 } }));
vi.mock('./audit.service', () => ({ recordAudit: () => { /* buffered elsewhere */ } }));
vi.mock('./backup.service', () => ({ exportBackup: async () => ({ totalRows: 0 }), backupFilename: () => 'x.nxb' }));
vi.mock('./backupRecovery.service', () => ({ hasRecoveryKey: async () => recovery.present }));

import { scheduleOverview, writeSchedule, SCHEDULE_STATE_SETTING } from './backupSchedule.service';
import { DEFAULT_SCHEDULE, type BackupSchedule } from '../lib/backupSchedule';

const NIGHTLY: BackupSchedule = {
  ...DEFAULT_SCHEDULE,
  enabled: true, hourUtc: 4, minuteUtc: 0,
  destination: { kind: 'directory', path: '/var/backups/nexus' },
};

/** 2026-08-01 09:00 UTC — five hours past that day's 04:00 window. */
const NOW = Date.UTC(2026, 7, 1, 9, 0);

beforeEach(() => {
  settings.clear();
  recovery.present = true;
  stored.length = 0;
});

const stampLastRun = (at: number) =>
  settings.set(SCHEDULE_STATE_SETTING, JSON.stringify({ lastRunAt: at, lastOutcome: 'ok' }));

describe('what the dashboard is told', () => {
  it('reports a run as owed when the schedule has never run', async () => {
    // The bug this exists to stop, found by watching a real gateway: `nextRunAt` is strictly AFTER
    // now, so a freshly-enabled schedule reported "in 12h 55m" — and the runner wrote a file
    // thirty seconds later. Both statements were true; the panel led with the wrong one.
    await writeSchedule(NIGHTLY);

    const view = await scheduleOverview(NOW);

    expect(view.dueNow).toBe(true);
    expect(view.nextRunAt).toBe(new Date(Date.UTC(2026, 7, 2, 4, 0)).toISOString());
  });

  it('reports a run as owed when the gateway was switched off through its window', async () => {
    // A missed window is caught up, not skipped — the operator asked for a nightly backup, not for
    // one on nights the machine happened to be awake.
    await writeSchedule(NIGHTLY);
    stampLastRun(Date.UTC(2026, 6, 31, 4, 0));   // yesterday's run; today's 04:00 has passed

    expect((await scheduleOverview(NOW)).dueNow).toBe(true);
  });

  it('reports nothing owed once the current window has been satisfied', async () => {
    await writeSchedule(NIGHTLY);
    stampLastRun(Date.UTC(2026, 7, 1, 4, 0));

    const view = await scheduleOverview(NOW);
    expect(view.dueNow).toBe(false);
    expect(view.nextRunAt).toBe(new Date(Date.UTC(2026, 7, 2, 4, 0)).toISOString());
  });

  it('never reports a run owed while the schedule is off', async () => {
    const view = await scheduleOverview(NOW);
    expect(view.schedule.enabled).toBe(false);
    expect(view.dueNow).toBe(false);
    // Nothing to name, rather than a date that will not be honoured.
    expect(view.nextRunAt).toBeNull();
  });

  it('surfaces the recovery key separately from whether backups are on', async () => {
    // "Backups are running" and "backups can be opened without this server" are different claims,
    // and only the second is what an operator thinks they bought.
    recovery.present = false;
    expect((await scheduleOverview(NOW)).hasRecoveryKey).toBe(false);
  });
});

describe('saving a schedule', () => {
  it('refuses to switch one on without a recovery key, while someone is reading', async () => {
    // Such a backup carries no passphrase, so `writeBackup` would refuse at 04:00 with nobody
    // watching. Refusing here turns a silent nightly failure into an answer at the moment of asking.
    recovery.present = false;
    await expect(writeSchedule(NIGHTLY)).rejects.toThrow(/no recovery key/i);
  });

  it('allows a schedule to be configured while it is still off', async () => {
    // Setting the time first and the folder second must not be blocked halfway.
    recovery.present = false;
    await expect(writeSchedule({ ...NIGHTLY, enabled: false, destination: { kind: 'directory', path: '' } }))
      .resolves.toMatchObject({ enabled: false });
  });

  it('refuses a relative folder, which means somewhere different depending on how it started', async () => {
    await expect(writeSchedule({
      ...NIGHTLY, copyOffMachine: true, destination: { kind: 'directory', path: 'backups' },
    })).rejects.toThrow(/full path/i);
  });

  it('accepts a schedule with no folder at all, because the database is the destination', async () => {
    // The regression this guards: requiring somewhere to put a backup is what made the feature
    // produce nothing on a host with no persistent disk.
    await expect(writeSchedule({
      ...NIGHTLY, copyOffMachine: false, destination: { kind: 'directory', path: '' },
    })).resolves.toMatchObject({ enabled: true });
  });
});
