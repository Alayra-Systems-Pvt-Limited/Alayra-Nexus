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

import { describe, it, expect } from 'vitest';
import {
  parseSchedule, scheduleProblem, destinationProblem, lastDueAt, nextDueAt, isDue, prunable,
  isBackupFilename, DEFAULT_SCHEDULE, MAX_EVERY_DAYS, MAX_KEEP, type BackupSchedule,
} from './backupSchedule';

/** A valid, switched-on schedule: every night at 04:00 UTC, keeping a week. */
const nightly = (over: Partial<BackupSchedule> = {}): BackupSchedule => ({
  ...DEFAULT_SCHEDULE,
  enabled: true,
  destination: { kind: 'directory', path: '/var/backups/nexus' },
  ...over,
});

const at = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);

describe('parseSchedule', () => {
  it('answers with the default for nothing, and for anything unreadable', () => {
    // A malformed row must never stop the gateway booting — the setting lives in a table an
    // operator can edit, and a backup schedule is not worth refusing to start over.
    expect(parseSchedule(null)).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule('')).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule('not json at all')).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule('null')).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule('[1,2,3]')).toMatchObject({ enabled: false });
  });

  it('defaults to OFF, so an unreadable setting can never start taking backups by itself', () => {
    expect(DEFAULT_SCHEDULE.enabled).toBe(false);
    expect(parseSchedule('{"everyDays":1}').enabled).toBe(false);
    // Only the literal boolean counts. A truthy string arriving from somewhere is not consent.
    expect(parseSchedule('{"enabled":"yes"}').enabled).toBe(false);
    expect(parseSchedule('{"enabled":1}').enabled).toBe(false);
    expect(parseSchedule('{"enabled":true}').enabled).toBe(true);
  });

  it('clamps out-of-range numbers instead of rejecting the whole schedule', () => {
    // Rejecting would turn one bad field into "backups silently stopped", which is the failure this
    // whole feature exists to prevent.
    const s = parseSchedule(JSON.stringify({
      enabled: true, everyDays: 9999, hourUtc: 99, minuteUtc: -5, keep: 0,
    }));
    expect(s.everyDays).toBe(MAX_EVERY_DAYS);
    expect(s.hourUtc).toBe(23);
    expect(s.minuteUtc).toBe(0);
    expect(s.keep).toBe(1);
  });

  it('falls back for values that are not numbers at all, and floors fractions', () => {
    const s = parseSchedule(JSON.stringify({ everyDays: 'three', hourUtc: null, minuteUtc: 30.9, keep: 7.2 }));
    expect(s.everyDays).toBe(DEFAULT_SCHEDULE.everyDays);
    expect(s.hourUtc).toBe(DEFAULT_SCHEDULE.hourUtc);
    expect(s.minuteUtc).toBe(30);
    expect(s.keep).toBe(7);
  });

  it('keeps the destination path when it is a string, and never invents one', () => {
    expect(parseSchedule('{"destination":{"path":"/srv/backups"}}').destination.path).toBe('/srv/backups');
    expect(parseSchedule('{"destination":{"path":42}}').destination.path).toBe('');
    expect(parseSchedule('{}').destination.path).toBe('');
  });
});

describe('destinationProblem', () => {
  it('accepts a full path on either kind of system', () => {
    expect(destinationProblem({ kind: 'directory', path: '/var/backups' })).toBeNull();
    expect(destinationProblem({ kind: 'directory', path: 'D:\\backups' })).toBeNull();
    expect(destinationProblem({ kind: 'directory', path: 'D:/backups' })).toBeNull();
    expect(destinationProblem({ kind: 'directory', path: '\\\\nas\\backups' })).toBeNull();
  });

  it('refuses a relative path, because it names a different folder per launch method', () => {
    // The gateway's working directory differs between `npx`, a systemd unit and a container. The
    // same configuration would write to three places and two of them would be wrong.
    const relative = destinationProblem({ kind: 'directory', path: 'backups' });
    expect(relative).toContain('full path');
    expect(destinationProblem({ kind: 'directory', path: './backups' })).toContain('full path');
    expect(destinationProblem({ kind: 'directory', path: '../backups' })).toContain('full path');
  });

  it('asks for a folder when there is none, rather than complaining about its shape', () => {
    expect(destinationProblem({ kind: 'directory', path: '' })).toContain('Choose a folder');
    expect(destinationProblem({ kind: 'directory', path: '   ' })).toContain('Choose a folder');
  });
});

describe('scheduleProblem', () => {
  it('passes a sound schedule', () => {
    expect(scheduleProblem(nightly())).toBeNull();
  });

  it('never demands a destination, because the gateway always has one', () => {
    // Every backup is stored in the database, so switching the schedule on cannot be blocked on
    // configuration — that is the whole reason it works unchanged on a host with no disk.
    expect(scheduleProblem({ ...DEFAULT_SCHEDULE, enabled: false })).toBeNull();
    expect(scheduleProblem({ ...DEFAULT_SCHEDULE, enabled: true })).toBeNull();
    expect(scheduleProblem(nightly({ copyOffMachine: false, destination: { kind: 'directory', path: '' } })))
      .toBeNull();
  });

  it('demands a folder only once the off-machine copy is switched on', () => {
    // The copy is the one part that needs somewhere to go. An operator who typed half a path and
    // left the copy off has not made a mistake worth refusing.
    expect(scheduleProblem(nightly({ copyOffMachine: true, destination: { kind: 'directory', path: '' } })))
      .toContain('Choose a folder');
    // And it is enforced even with the schedule off, because "Back up now" copies too.
    expect(scheduleProblem(nightly({
      enabled: false, copyOffMachine: true, destination: { kind: 'directory', path: '' },
    }))).toContain('Choose a folder');
  });

  it('names the field that is wrong', () => {
    expect(scheduleProblem(nightly({ everyDays: 0 }))).toContain('1 to');
    expect(scheduleProblem(nightly({ everyDays: MAX_EVERY_DAYS + 1 }))).toContain('1 to');
    expect(scheduleProblem(nightly({ hourUtc: 24 }))).toContain('hour');
    expect(scheduleProblem(nightly({ minuteUtc: 60 }))).toContain('minute');
    expect(scheduleProblem(nightly({ keep: 0 }))).toContain('Keep between');
    expect(scheduleProblem(nightly({ keep: MAX_KEEP + 1 }))).toContain('Keep between');
  });
});

describe('when a run falls due', () => {
  // 2026-08-01 is UTC day 20666. 20666 % 1 === 0, so every day qualifies for a nightly schedule.
  const s = nightly();

  it('is due the moment the window is reached, and not a minute before', () => {
    // Stated against a gateway that ALREADY ran last night. With no previous run at all the answer
    // is "due" at every instant, by design — see the next test — so `null` here would be asserting
    // something else entirely.
    const window = at(2026, 8, 1, 4, 0);
    const ranLastNight = at(2026, 7, 31, 4, 0);
    expect(isDue(s, ranLastNight, window - 60_000)).toBe(false);
    expect(isDue(s, ranLastNight, window)).toBe(true);
  });

  it('is due immediately when it has never run — switching it on means you want a backup', () => {
    expect(isDue(s, null, at(2026, 8, 1, 14, 0))).toBe(true);
  });

  it('does not run twice in the same window', () => {
    const now = at(2026, 8, 1, 4, 30);
    // Already ran at 04:01 today.
    expect(isDue(s, at(2026, 8, 1, 4, 1), now)).toBe(false);
    // ...and still does not, later the same day.
    expect(isDue(s, at(2026, 8, 1, 4, 1), at(2026, 8, 1, 23, 59))).toBe(false);
  });

  it('comes due again the next night', () => {
    expect(isDue(s, at(2026, 8, 1, 4, 1), at(2026, 8, 2, 4, 0))).toBe(true);
  });

  it('CATCHES UP a window the gateway slept through', () => {
    // Switched off across two nights and started again at 09:00. The operator asked for a daily
    // backup, not for one on days the machine happened to be awake — so it is owed one now.
    const lastRun = at(2026, 7, 29, 4, 0);
    expect(isDue(s, lastRun, at(2026, 8, 1, 9, 0))).toBe(true);
  });

  it('a catch-up run does not also make the NEXT one late', () => {
    // Caught up at 09:00 on the 1st. That must not push the cycle to 09:00 — the following night's
    // 04:00 is still owed, which is what anchoring to the due instant (not to the last run) buys.
    const caughtUpAt = at(2026, 8, 1, 9, 0);
    expect(isDue(s, caughtUpAt, at(2026, 8, 1, 23, 0))).toBe(false);
    expect(isDue(s, caughtUpAt, at(2026, 8, 2, 4, 0))).toBe(true);
  });

  it('is never due while switched off, however overdue it looks', () => {
    expect(isDue({ ...s, enabled: false }, null, at(2030, 1, 1, 12, 0))).toBe(false);
  });

  it('honours a multi-day cycle without storing an anchor', () => {
    // Every 3 days, anchored to the epoch, so two replicas and a restored gateway all agree without
    // sharing any state about when the operator switched it on.
    const every3 = nightly({ everyDays: 3 });
    const day = (n: number) => Math.floor(at(2026, 8, n, 4, 0) / 86_400_000);

    const qualifying = [1, 2, 3, 4, 5, 6].filter((n) => day(n) % 3 === 0);
    expect(qualifying.length).toBeGreaterThan(0);

    for (const n of qualifying) {
      const window = at(2026, 8, n, 4, 0);
      // Ran on the previous qualifying day, so this window is owed.
      expect(isDue(every3, window - 3 * 86_400_000, window)).toBe(true);
      // The day after a qualifying day is not itself a window.
      expect(isDue(every3, window, window + 86_400_000)).toBe(false);
    }
  });
});

describe('lastDueAt and nextDueAt', () => {
  const s = nightly();

  it('name the windows either side of now', () => {
    const now = at(2026, 8, 1, 12, 0);
    expect(lastDueAt(s, now)).toBe(at(2026, 8, 1, 4, 0));
    expect(nextDueAt(s, now)).toBe(at(2026, 8, 2, 4, 0));
  });

  it('reach back to yesterday before today’s window arrives', () => {
    const now = at(2026, 8, 1, 3, 0);
    expect(lastDueAt(s, now)).toBe(at(2026, 7, 31, 4, 0));
    expect(nextDueAt(s, now)).toBe(at(2026, 8, 1, 4, 0));
  });

  it('treat the window itself as past, not future — the boundary belongs to the run', () => {
    const window = at(2026, 8, 1, 4, 0);
    expect(lastDueAt(s, window)).toBe(window);
    expect(nextDueAt(s, window)).toBeGreaterThan(window);
  });

  it('always move forward, for every hour of every day of a long cycle', () => {
    // A next-run time that is not in the future is a dashboard that says "next run: 3 hours ago".
    for (const everyDays of [1, 2, 3, 7, 30]) {
      for (const hourUtc of [0, 4, 13, 23]) {
        const cfg = nightly({ everyDays, hourUtc, minuteUtc: 30 });
        for (const d of [1, 2, 3, 15, 28]) {
          const now = at(2026, 8, d, hourUtc, 30); // exactly on a window boundary — the hard case
          expect(nextDueAt(cfg, now)).toBeGreaterThan(now);
          const prev = lastDueAt(cfg, now);
          if (prev !== null) expect(prev).toBeLessThanOrEqual(now);
        }
      }
    }
  });
});

describe('which files retention may delete', () => {
  const name = (stamp: string) => `alayra-nexus-backup-${stamp}.nxb`;
  const files = [
    name('2026-07-28-04-00-00'),
    name('2026-07-29-04-00-00'),
    name('2026-07-30-04-00-00'),
    name('2026-07-31-04-00-00'),
    name('2026-08-01-04-00-00'),
  ];

  it('deletes the oldest, keeping exactly the number asked for', () => {
    expect(prunable(files, 2)).toEqual([
      name('2026-07-28-04-00-00'), name('2026-07-29-04-00-00'), name('2026-07-30-04-00-00'),
    ]);
    expect(prunable(files, 5)).toEqual([]);
    expect(prunable(files, 99)).toEqual([]);
  });

  it('sorts by name, which for these names is sorting by age', () => {
    // The stamps are zero-padded UTC, so no file has to be opened or stat-ed to decide its age —
    // and a directory listing arriving in any order gives the same answer.
    const shuffled = [files[3], files[0], files[4], files[1], files[2]];
    expect(prunable(shuffled, 1)).toEqual(files.slice(0, 4));
  });

  it('NEVER touches a file the gateway did not write', () => {
    // The operator may point the destination at a folder holding their own archives, a mount point,
    // or the wrong path entirely. Deleting "the oldest files here" would destroy data this gateway
    // was never asked to manage.
    const foreign = [
      'important-tax-records.zip',
      'alayra-nexus-backup.nxb',                    // no stamp — not ours
      'alayra-nexus-backup-2026-08-01-04-00-00.nxb.bak',
      'ALAYRA-NEXUS-BACKUP-2026-07-01-04-00-00.NXB', // different case — not what we write
      '.hidden',
    ];
    expect(prunable([...foreign, ...files], 1)).toEqual(files.slice(0, 4));
    expect(prunable(foreign, 1)).toEqual([]);
  });

  it('deletes nothing for a nonsensical keep, because that is the safe direction', () => {
    expect(prunable(files, 0)).toEqual([]);
    expect(prunable(files, -1)).toEqual([]);
    expect(prunable(files, 1.5)).toEqual([]);
    expect(prunable(files, NaN)).toEqual([]);
  });

  it('recognises exactly the names backupFilename produces', () => {
    expect(isBackupFilename('alayra-nexus-backup-2026-08-01-10-23-34.nxb')).toBe(true);
    expect(isBackupFilename('alayra-nexus-backup-2026-08-01-10-23-34.nxb.tmp')).toBe(false);
    expect(isBackupFilename('backup-2026-08-01-10-23-34.nxb')).toBe(false);
  });
});
