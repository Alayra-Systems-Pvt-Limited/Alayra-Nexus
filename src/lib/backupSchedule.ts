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

// When a scheduled backup is due, and which old ones may be deleted (Phase B2).
//
// Everything here is PURE — no clock, no filesystem, no database. "Was a backup due at 04:00 on a
// day the gateway was switched off?" and "which of these fourteen files may be deleted?" are the two
// questions this feature can get wrong in ways nobody notices until the day it matters, and both are
// answerable from arguments alone. The service next door does the I/O and asks these.
//
// ── Why there is no cron expression ───────────────────────────────────────────────────────────
//
// `0 4 */3 * *` is a thing an operator can get subtly wrong and cannot check without running it, and
// it can express schedules a backup should never have ("every minute", "only in March"). Every hour
// and minute of a repeating N-day cycle is the whole useful range, and it can be rendered back to
// the operator as a sentence they can confirm.

/** Where a scheduled backup is written. One kind today; B3 adds others behind the same field. */
export interface BackupDestination {
  kind: 'directory';
  /** A path on the gateway's own filesystem. Absolute — see `destinationProblem`. */
  path: string;
}

export interface BackupSchedule {
  enabled: boolean;
  /** Days between runs. 1 is nightly. */
  everyDays: number;
  /**
   * The time of day a run is due, in UTC.
   *
   * UTC and not the server's local zone, deliberately: a container's local time is whatever the
   * image happened to be built with, so "03:00" would mean different things in the same deployment
   * before and after a base-image bump. The dashboard renders it in the operator's zone.
   */
  hourUtc: number;
  minuteUtc: number;
  /** How many files to keep at the destination. Older ones are removed after a successful run. */
  keep: number;
  destination: BackupDestination;
}

export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  everyDays: 1,
  // Late enough to be after midnight-adjacent batch work almost everywhere, early enough that a
  // failure is noticed during the working day rather than the following night.
  hourUtc: 4,
  minuteUtc: 0,
  keep: 7,
  destination: { kind: 'directory', path: '' },
};

export const MAX_EVERY_DAYS = 30;
export const MAX_KEEP = 365;

const DAY_MS = 86_400_000;

/**
 * Exactly the names `backupFilename()` produces.
 *
 * Retention deletes files, so this is a safety boundary rather than a convenience. An operator may
 * point the destination at a directory that already holds something else — their own archives, a
 * mount point, the wrong path entirely — and a sweep that deleted "the oldest files here" would
 * destroy data the gateway never wrote and was never asked to manage.
 */
export const BACKUP_FILENAME = /^alayra-nexus-backup-\d{4}(-\d{2}){5}\.nxb$/;

export const isBackupFilename = (name: string): boolean => BACKUP_FILENAME.test(name);

/** Read a stored schedule, tolerating anything. A malformed row must never stop the gateway booting. */
export function parseSchedule(raw: string | null): BackupSchedule {
  if (!raw) return DEFAULT_SCHEDULE;

  let parsed: Partial<BackupSchedule> & { destination?: Partial<BackupDestination> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return DEFAULT_SCHEDULE;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SCHEDULE;

  const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? Math.floor(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  return {
    // Clamped rather than rejected: a stored value out of range is a bug somewhere upstream, and
    // refusing to schedule at all would turn it into "backups silently stopped".
    enabled:   parsed.enabled === true,
    everyDays: int(parsed.everyDays, DEFAULT_SCHEDULE.everyDays, 1, MAX_EVERY_DAYS),
    hourUtc:   int(parsed.hourUtc,   DEFAULT_SCHEDULE.hourUtc,   0, 23),
    minuteUtc: int(parsed.minuteUtc, DEFAULT_SCHEDULE.minuteUtc, 0, 59),
    keep:      int(parsed.keep,      DEFAULT_SCHEDULE.keep,      1, MAX_KEEP),
    destination: {
      kind: 'directory',
      path: typeof parsed.destination?.path === 'string' ? parsed.destination.path : '',
    },
  };
}

/**
 * Why a destination cannot be used, in words an operator can act on — or null when it is usable.
 *
 * Relative paths are refused because the answer to "relative to what?" is the gateway's working
 * directory, which differs between `npx`, a systemd unit and a container. The same configuration
 * would then write to three different places, and two of them would be wrong.
 */
export function destinationProblem(d: BackupDestination): string | null {
  const path = d.path.trim();
  if (path.length === 0) return 'Choose a folder for the gateway to write backups into.';
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  if (!absolute) {
    return 'Use a full path, starting from the root of the disk — a relative path means somewhere different depending on how the gateway was started.';
  }
  return null;
}

/** Why a schedule cannot be saved, or null. Only enforced when it is actually switched on. */
export function scheduleProblem(s: BackupSchedule): string | null {
  if (!Number.isInteger(s.everyDays) || s.everyDays < 1 || s.everyDays > MAX_EVERY_DAYS) {
    return `Run the backup every 1 to ${MAX_EVERY_DAYS} days.`;
  }
  if (!Number.isInteger(s.hourUtc) || s.hourUtc < 0 || s.hourUtc > 23) return 'Choose an hour between 0 and 23.';
  if (!Number.isInteger(s.minuteUtc) || s.minuteUtc < 0 || s.minuteUtc > 59) return 'Choose a minute between 0 and 59.';
  if (!Number.isInteger(s.keep) || s.keep < 1 || s.keep > MAX_KEEP) return `Keep between 1 and ${MAX_KEEP} backups.`;
  // A schedule that is off does not need a destination — an operator configuring the time first and
  // the folder second should not be blocked halfway.
  return s.enabled ? destinationProblem(s.destination) : null;
}

/** Whether a UTC day number falls on the cycle. Anchored to the epoch so nothing has to be stored. */
const onCycle = (utcDay: number, everyDays: number): boolean => utcDay % everyDays === 0;

/**
 * The most recent instant this schedule was due, at or before `now`. Null if none has occurred yet.
 *
 * Anchored to the epoch rather than to when the operator switched the feature on, so the answer
 * never depends on state that a restore, a redeploy or a second replica might not share.
 */
export function lastDueAt(s: BackupSchedule, now: number): number | null {
  const timeOfDay = (s.hourUtc * 60 + s.minuteUtc) * 60_000;
  const today = Math.floor(now / DAY_MS);

  // At most `everyDays` steps back reaches the previous qualifying day in every case.
  for (let i = 0; i <= s.everyDays; i++) {
    const day = today - i;
    if (!onCycle(day, s.everyDays)) continue;
    const at = day * DAY_MS + timeOfDay;
    if (at <= now) return at;
  }
  return null;
}

/** The next instant this schedule falls due, strictly after `now`. For showing "next run". */
export function nextDueAt(s: BackupSchedule, now: number): number {
  const timeOfDay = (s.hourUtc * 60 + s.minuteUtc) * 60_000;
  const today = Math.floor(now / DAY_MS);

  for (let i = 0; i <= s.everyDays + 1; i++) {
    const day = today + i;
    if (!onCycle(day, s.everyDays)) continue;
    const at = day * DAY_MS + timeOfDay;
    if (at > now) return at;
  }
  // Unreachable for everyDays >= 1; a total rather than an exception keeps the caller simple.
  return now + s.everyDays * DAY_MS;
}

/**
 * Whether a run is owed right now.
 *
 * A missed window is CAUGHT UP rather than skipped: a gateway that was switched off at 04:00 takes
 * its backup when it comes back, because the operator asked for a daily backup and not for one only
 * on days the machine happened to be awake. The comparison against the last DUE instant — rather
 * than "has a day elapsed since the last run" — is what stops the catch-up run from also making the
 * next one late, and what stops two replicas disagreeing about whose clock started the cycle.
 *
 * Never run before means due immediately: an operator who switches this on wants a backup, not a
 * promise of one tomorrow night.
 */
export function isDue(s: BackupSchedule, lastRunAt: number | null, now: number): boolean {
  if (!s.enabled) return false;
  const due = lastDueAt(s, now);
  if (due === null) return false;
  return lastRunAt === null || lastRunAt < due;
}

/**
 * Which files at the destination may be deleted, oldest first.
 *
 * Only files the gateway itself wrote are ever considered — see BACKUP_FILENAME. The names carry a
 * zero-padded UTC timestamp, so sorting them as strings sorts them by age, and no file has to be
 * opened or stat-ed to decide. Returns [] rather than throwing for a nonsensical `keep`, because the
 * safe direction for a function that decides what to delete is always "nothing".
 */
export function prunable(filenames: readonly string[], keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const ours = filenames.filter(isBackupFilename).sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}
