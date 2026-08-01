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

// The unattended backup: taking one, keeping the right number, and saying what happened (Phase B2).
//
// The decisions live next door in lib/backupSchedule (pure, heavily tested); this is the I/O.
//
// ── Why the configuration lives in AppSettings ────────────────────────────────────────────────
//
// The same three reasons the recovery key does (backupRecovery.service.ts). A new model would need
// a PostgreSQL migration AND a regenerated sqlite-schema.sql; it would change the schema shape C1
// records, so every backup taken before it would report drift; and AppSettings is already backed up,
// which means a restored gateway resumes its own backup schedule instead of quietly stopping.
//
// ── Why the run state is read straight from the table ─────────────────────────────────────────
//
// `getSetting` is a read-through cache with a five-minute TTL. That is right for settings read on
// every request and wrong for the timestamp that decides whether to take a backup: two replicas
// holding a five-minute-stale `lastRunAt` would both believe a run is owed. The lock below makes
// that safe, but correctness should not rest on the lock alone, and this row is read once a minute.

import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { recordAudit } from './audit.service';
import { exportBackup, backupFilename } from './backup.service';
import { hasRecoveryKey } from './backupRecovery.service';
import { destinationAdapter } from '../lib/backupDestination';
import {
  parseSchedule, scheduleProblem, destinationProblem, isDue, nextDueAt, prunable,
  type BackupSchedule,
} from '../lib/backupSchedule';

export const SCHEDULE_SETTING = 'BACKUP_SCHEDULE';
export const SCHEDULE_STATE_SETTING = 'BACKUP_SCHEDULE_STATE';

/**
 * Only one instance may take the backup.
 *
 * Without this, every replica of a horizontally-scaled gateway wakes at 04:00, reads the same
 * `lastRunAt`, and they all start exporting the whole database at once — into the same directory,
 * under names that differ by a second or not at all.
 */
export const SCHEDULE_LOCK_KEY = 'nexus:backup:schedule:lock';

/** Long enough for a large gateway's export; short enough that a killed process frees it by morning. */
const LOCK_TTL_SECONDS = 2 * 60 * 60;

/** How often the runner asks whether anything is owed. */
export const TICK_MS = 60_000;

export interface ScheduleRunState {
  lastRunAt: number | null;
  lastOutcome: 'ok' | 'failed' | null;
  /** The gateway's own words about the last failure. Null after a success. */
  lastError: string | null;
  lastFilename: string | null;
  lastBytes: number | null;
  lastRows: number | null;
  /** Old backups removed by retention on the last successful run. */
  lastPruned: number | null;
}

const EMPTY_STATE: ScheduleRunState = {
  lastRunAt: null, lastOutcome: null, lastError: null,
  lastFilename: null, lastBytes: null, lastRows: null, lastPruned: null,
};

// ── Configuration ─────────────────────────────────────────────────────────────

export async function readSchedule(): Promise<BackupSchedule> {
  const row = await prisma.appSettings.findUnique({ where: { key: SCHEDULE_SETTING } });
  return parseSchedule(row?.value ?? null);
}

/** Persist a schedule. Throws with the operator's own next step if it is not usable. */
export async function writeSchedule(s: BackupSchedule): Promise<BackupSchedule> {
  const problem = scheduleProblem(s);
  if (problem) throw new Error(problem);

  // A scheduled backup carries no passphrase — nobody is present to type one — so the recovery key
  // is the only thing that can open it once the machine is gone. Switching this on without one
  // would produce files openable solely by the server they are meant to survive, and `writeBackup`
  // would refuse at 04:00 with nobody watching. Refuse now instead, while someone is reading.
  if (s.enabled && !(await hasRecoveryKey())) {
    throw new Error(
      'This gateway has no recovery key, so an unattended backup could only ever be opened by this same server — which is what a backup exists to survive. Create a recovery key first.',
    );
  }

  await prisma.appSettings.upsert({
    where:  { key: SCHEDULE_SETTING },
    create: { key: SCHEDULE_SETTING, value: JSON.stringify(s) },
    update: { value: JSON.stringify(s) },
  });
  return s;
}

export async function readState(): Promise<ScheduleRunState> {
  const row = await prisma.appSettings.findUnique({ where: { key: SCHEDULE_STATE_SETTING } });
  if (!row?.value) return EMPTY_STATE;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(row.value) as Partial<ScheduleRunState>) };
  } catch {
    // An unreadable state row means "we do not know when it last ran", which `isDue` treats as
    // never — one extra backup. The other direction would be silently skipping them.
    return EMPTY_STATE;
  }
}

async function writeState(state: ScheduleRunState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.appSettings.upsert({
    where:  { key: SCHEDULE_STATE_SETTING },
    create: { key: SCHEDULE_STATE_SETTING, value },
    update: { value },
  });
}

// ── The lock ──────────────────────────────────────────────────────────────────

async function acquire(token: string): Promise<boolean> {
  return (await redis.set(SCHEDULE_LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX')) === 'OK';
}

/**
 * Release only if we still hold it.
 *
 * A lock that outlived its TTL now belongs to whoever took it next, and deleting it blindly would
 * let two exports run at once — the exact thing it prevents. The read-then-delete is not atomic, so
 * a vanishingly narrow window remains; the cost of losing that race is one skipped tick a minute
 * later, which is why it does not warrant a Lua script.
 */
async function release(token: string): Promise<void> {
  try {
    if ((await redis.get(SCHEDULE_LOCK_KEY)) === token) await redis.del(SCHEDULE_LOCK_KEY);
  } catch { /* the TTL is the backstop */ }
}

// ── Taking one ────────────────────────────────────────────────────────────────

export interface RunOutcome {
  ran: boolean;
  filename?: string;
  bytes?: number;
  rows?: number;
  pruned?: number;
  error?: string;
}

/**
 * Take a backup now, whatever the schedule says. Used by the runner and by "Back up now".
 *
 * Retention runs only after a COMMITTED file. Deleting last week's backups because tonight's failed
 * is precisely the wrong response to a failure, and it is what a naive "make room, then write"
 * ordering would do.
 */
export async function runBackupNow(schedule: BackupSchedule, now = Date.now()): Promise<RunOutcome> {
  const adapter = destinationAdapter(schedule.destination);
  const filename = backupFilename(new Date(now));

  try {
    await adapter.ensure();

    const sink = await adapter.begin(filename);
    let rows: number;
    try {
      // No passphrase: nobody is here to type one. The gateway recipient lets this same gateway
      // restore itself unattended, and the recovery recipient — added automatically whenever the
      // gateway has one — is what lets the operator open it when the gateway is gone.
      rows = (await exportBackup(undefined, sink.out, true)).totalRows;
    } catch (err) {
      await sink.abort();
      throw err;
    }
    const bytes = await sink.commit();

    const doomed = prunable(await adapter.list(), schedule.keep);
    for (const name of doomed) {
      await adapter.remove(name).catch(() => { /* a backup that was taken beats a tidy folder */ });
    }

    recordAudit({
      action: 'backup.scheduled', method: 'SYSTEM', actorRole: 'system', status: 200,
      detail: JSON.stringify({ filename, bytes, rows, pruned: doomed.length, destination: adapter.describe() }),
    });
    return { ran: true, filename, bytes, rows, pruned: doomed.length };
  } catch (err) {
    const error = (err as Error).message;
    // Audited at status 500 so a silently failing schedule is visible in the one place an operator
    // already looks. A backup nobody knows stopped happening is worse than no backup at all.
    recordAudit({
      action: 'backup.scheduled', method: 'SYSTEM', actorRole: 'system', status: 500,
      detail: JSON.stringify({ outcome: 'failed', error, destination: adapter.describe() }),
    });
    return { ran: false, error };
  }
}

/**
 * One pass of the runner: is anything owed, and if so, take it.
 *
 * `lastRunAt` is stamped whether the run succeeded or failed. A destination that is unreachable
 * would otherwise stay due, and the gateway would retry a failing export every sixty seconds all
 * night — turning a misconfigured folder into a self-inflicted outage. The failure is recorded and
 * the next window is tried.
 */
export async function tick(now = Date.now()): Promise<RunOutcome> {
  const schedule = await readSchedule();
  if (!schedule.enabled) return { ran: false };
  // Cheap check before reaching for the lock, so a gateway with nothing owed does one small read a
  // minute rather than a KV round trip per replica.
  if (!isDue(schedule, (await readState()).lastRunAt, now)) return { ran: false };

  return underLock(schedule, now, async () => {
    // Re-checked under the lock: between the check above and here, another replica may have taken
    // the very backup this one is about to duplicate.
    if (!isDue(schedule, (await readState()).lastRunAt, now)) return { ran: false };
    return runBackupNow(schedule, now);
  });
}

/**
 * "Back up now" — the same machinery, without asking whether it was due.
 *
 * Takes the same lock as the schedule, so an operator pressing the button at 03:59 cannot collide
 * with the run that starts a minute later, and stamps `lastRunAt` for the same reason: the manual
 * backup satisfies tonight's window, and taking a second one an hour later would be pure noise.
 */
export async function runNow(now = Date.now()): Promise<RunOutcome> {
  const schedule = await readSchedule();
  const problem = destinationProblem(schedule.destination);
  if (problem) return { ran: false, error: problem };

  return underLock(schedule, now, () => runBackupNow(schedule, now));
}

/** Hold the lock, run, record what happened. Never leaves the lock behind. */
async function underLock(
  schedule: BackupSchedule,
  now: number,
  work: () => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const token = randomUUID();
  if (!(await acquire(token))) return { ran: false };   // another instance has it

  try {
    const outcome = await work();
    // Nothing to record when no run was attempted — writing state here would stamp `lastRunAt` for
    // a backup that never happened, and silence the schedule until tomorrow.
    if (!outcome.ran && !outcome.error) return outcome;

    await writeState({
      lastRunAt: now,
      lastOutcome: outcome.ran ? 'ok' : 'failed',
      lastError: outcome.error ?? null,
      lastFilename: outcome.filename ?? null,
      lastBytes: outcome.bytes ?? null,
      lastRows: outcome.rows ?? null,
      lastPruned: outcome.pruned ?? null,
    });
    return outcome;
  } finally {
    await release(token);
  }
}

// ── The runner ────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Never allowed to reject: an unhandled rejection here would take the process down over a
    // backup, which is a strictly worse outcome than a missed one.
    void tick().catch((err) => console.warn('⚠️  Scheduled backup check failed:', (err as Error).message));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();  // never hold the process open
}

export function stopBackupScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** What the dashboard shows: the schedule, the last run, and when the next one is due. */
export async function scheduleOverview(now = Date.now()) {
  const schedule = await readSchedule();
  const state = await readState();
  return {
    schedule,
    state,
    nextRunAt: schedule.enabled ? new Date(nextDueAt(schedule, now)).toISOString() : null,
    // Surfaced rather than inferred: "backups are on" and "backups can be opened without this
    // server" are different claims, and only one of them is what an operator thinks they bought.
    hasRecoveryKey: await hasRecoveryKey(),
  };
}
