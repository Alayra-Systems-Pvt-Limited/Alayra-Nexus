/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The copy kept outside the gateway, against a real directory.
//
// ── Why this file had to exist ────────────────────────────────────────────────────────────────
//
// `backupCopy.service.ts` had no test of any kind. It is the path the dashboard's data-loss notice
// reports on: the notice turns amber and says the copy is failing, and until now nothing anywhere
// proved that a copy either succeeds or fails in the way that claim depends on. The most important
// state of the loudest warning in the product was unverified.
//
// It is also the only place in the backup track that DELETES. `copyOffMachine` prunes old copies to
// stay within the retention limit, and the ordering of those two steps is the whole safety property:
// write first, then prune. Reversed — or simply not conditional on success — a NAS that went offline
// at 3am would cause last week's copies to be deleted to make room for a backup that never arrived.
// That is a data-loss bug with a green tick beside it, and it is one line away at all times.
//
// ── Why the filesystem is real and only the read is stubbed ───────────────────────────────────
//
// The half-written file is the failure this design exists to prevent, and it is a filesystem
// property: `.partial` then rename, atomic within a directory. A mocked fs would let a test assert
// that rename was called, which is not the same claim as "no file with a backup name is ever
// incomplete". So the directory is a real temp directory and the adapter runs for real.
//
// `readStoredBackup` is stubbed because the bytes' origin is irrelevant here and it is the only way
// to make a read fail HALFWAY, which is the case that matters most and the one a real database
// makes very hard to arrange.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readStoredBackup } = vi.hoisted(() => ({ readStoredBackup: vi.fn() }));
vi.mock('../lib/backup/backupStore', () => ({ readStoredBackup }));

import { copyOffMachine } from './backupCopy.service';
import { PARTIAL_SUFFIX } from '../lib/backupDestination';
import type { BackupDestination } from '../lib/backupSchedule';
import type { StoredBackup } from '../lib/backup/backupStore';

/** Real bytes, with a NUL and a high byte in them so any text handling on the way out shows up. */
const CONTENTS = Buffer.from([0x7b, 0x22, 0x66, 0x00, 0xff, 0x0a, 0x53, 0x45, 0x41, 0x4c, 0x45, 0x44]);

/** The exact shape `BACKUP_FILENAME` accepts. Anything else is invisible to retention. */
const name = (day: number) => `alayra-nexus-backup-2026-05-${String(day).padStart(2, '0')}-03-00-00.nxb`;

const stored = (filename: string, bytes = CONTENTS.length): StoredBackup => ({
  id: `bk-${filename}`, filename, createdAt: new Date('2026-05-06T03:00:00Z'),
  bytes, rows: 1200, origin: 'scheduled',
});

let dir = '';
const destination = (): BackupDestination => ({ kind: 'directory', path: dir });

/** Everything at the destination, so a test can say what is and is not there. */
const entries = () => readdirSync(dir).sort();

/** A stream that hands over some bytes and then fails, which is the case a real database resists. */
function breaksHalfway(message: string): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) { sent = true; this.push(CONTENTS.subarray(0, 4)); return; }
      this.destroy(new Error(message));
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'nexus-copy-'));
  readStoredBackup.mockReturnValue(Readable.from([CONTENTS]));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that outlives a test is not a failure */ }
});

// ── The copy itself ───────────────────────────────────────────────────────────

describe('a backup that reaches the destination', () => {
  it('arrives byte for byte, under the name it was stored as', async () => {
    const outcome = await copyOffMachine(stored(name(6)), destination(), 5);

    expect(outcome.copied).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(entries()).toEqual([name(6)]);

    // Compared as bytes, not as text. This artifact is the one an operator restores from a year
    // later, and an encoding applied on the way out would not shorten it or change its name.
    expect(readFileSync(join(dir, name(6)))).toEqual(CONTENTS);
  });

  it('names where it went, so the dashboard and the audit trail can say', async () => {
    const outcome = await copyOffMachine(stored(name(6)), destination(), 5);
    expect(outcome.destination).toBe(dir);
  });

  it('leaves nothing behind under a partial name', async () => {
    await copyOffMachine(stored(name(6)), destination(), 5);
    // A `.partial` still sitting there means commit never renamed, and the next run's retention
    // would be reasoning about a file that is not a backup.
    expect(entries().some((e) => e.endsWith(PARTIAL_SUFFIX))).toBe(false);
  });
});

// ── The failure this design exists to prevent ─────────────────────────────────

describe('a copy that fails partway', () => {
  it('leaves NO file at the destination — not a partial one, and certainly not a named one', async () => {
    readStoredBackup.mockReturnValue(breaksHalfway('the database went away'));

    const outcome = await copyOffMachine(stored(name(6)), destination(), 5);

    expect(outcome.copied).toBe(false);
    expect(outcome.error).toContain('the database went away');

    // The worst artefact this system can produce is a file with a real backup's name that will not
    // authenticate: retention counts it as good and deletes a real one to make room, and the
    // operator finds out on the day they need it. `abort` is what prevents that, and this is the
    // only assertion anywhere that it ran.
    expect(entries()).toEqual([]);
  });

  it('reports a destination it cannot use, rather than throwing at the caller', async () => {
    // A file where a folder should be — the shape of a mistyped path, and of a mount that vanished.
    const notADirectory = join(dir, 'occupied');
    writeFileSync(notADirectory, 'I am not a folder');

    const outcome = await copyOffMachine(stored(name(6)), { kind: 'directory', path: notADirectory }, 5);

    expect(outcome.copied).toBe(false);
    // Returned, never thrown: the BACKUP succeeded and is in the database. Turning an unreachable
    // destination into a raised error would make the runner report a failed backup, sending the
    // operator to look in the wrong place for a file that is actually there.
    expect(outcome.error).toBeTruthy();
    expect(outcome.destination).toBe(notADirectory);
  });
});

// ── Retention, which is the only thing here that deletes ──────────────────────

describe('old copies are removed only once a new one is safely there', () => {
  /** Five of ours, plus two files that are not ours and must be left alone. */
  const seedDestination = () => {
    for (let day = 1; day <= 5; day += 1) writeFileSync(join(dir, name(day)), `old ${day}`);
    writeFileSync(join(dir, 'notes.txt'), 'an operator put this here');
    writeFileSync(join(dir, `${name(9)}${PARTIAL_SUFFIX}`), 'a crash left this');
  };

  it('removes the oldest of ours, and only ours', async () => {
    seedDestination();

    // Five already there plus the one just written is six; keeping three means three go.
    const outcome = await copyOffMachine(stored(name(6)), destination(), 3);

    expect(outcome.copied).toBe(true);
    expect(outcome.pruned).toBe(3);

    // The three newest of ours survive, and the two files the gateway did not write are untouched.
    // `prunable` filters by the exact filename shape precisely so a destination an operator also
    // uses for something else is never damaged by a retention pass.
    expect(entries()).toEqual([
      name(4), name(5), name(6), `${name(9)}${PARTIAL_SUFFIX}`, 'notes.txt',
    ].sort());
  });

  it('removes NOTHING when the copy failed', async () => {
    seedDestination();
    readStoredBackup.mockReturnValue(breaksHalfway('the mount disappeared'));

    const outcome = await copyOffMachine(stored(name(6)), destination(), 1);

    expect(outcome.copied).toBe(false);
    expect(outcome.pruned).toBeUndefined();

    // The property this whole test file is here for. `keep: 1` would have deleted four good copies
    // to make room for a backup that never arrived — the failure response that turns one bad night
    // into the loss of every previous one. Retention lives after `commit` for exactly this reason,
    // and nothing but this assertion holds it there.
    expect(entries()).toEqual([
      name(1), name(2), name(3), name(4), name(5), `${name(9)}${PARTIAL_SUFFIX}`, 'notes.txt',
    ].sort());
  });

  it('still reports the copy as made when the tidying up fails', async () => {
    for (let day = 1; day <= 5; day += 1) writeFileSync(join(dir, name(day)), `old ${day}`);
    // A directory wearing a backup's name: `rm` without `recursive` refuses it. Contrived, but the
    // real versions — a permission change, a file held open, a read-only remount — are not, and
    // they arrive at the same line.
    rmSync(join(dir, name(1)));
    mkdirSync(join(dir, name(1)));

    const outcome = await copyOffMachine(stored(name(6)), destination(), 5);

    // A copy that was made beats a tidy folder. Failing the run here would report a backup as lost
    // when it is sitting at the destination, which is the more dangerous of the two lies.
    expect(outcome.copied).toBe(true);
    expect(readFileSync(join(dir, name(6)))).toEqual(CONTENTS);
    expect(entries()).toContain(name(1)); // the one that refused to go is still there
  });
});
