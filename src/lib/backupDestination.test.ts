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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destinationAdapter, PARTIAL_SUFFIX } from './backupDestination';
import { isBackupFilename } from './backupSchedule';

// Real files in a real temporary directory. The whole point of this adapter is what happens on a
// filesystem — half-written files, renames, a directory that is not there — and a mocked `fs` would
// assert only that the code calls the functions it calls.

const NAME = 'alayra-nexus-backup-2026-08-01-04-00-00.nxb';

let dir = '';
const adapter = () => destinationAdapter({ kind: 'directory', path: dir });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nexus-dest-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('a backup never appears under its final name until it is whole', () => {
  it('writes to a .partial file, and renames only on commit', async () => {
    const sink = await adapter().begin(NAME);
    sink.out.write('the first half');

    // THE assertion this adapter exists for. A file carrying a backup's name, a plausible size and
    // no authentication tag is the worst artefact this system can produce: retention would count it
    // as a good backup and delete a real one to make room for it.
    expect(await readdir(dir)).toEqual([`${NAME}${PARTIAL_SUFFIX}`]);
    expect(isBackupFilename(`${NAME}${PARTIAL_SUFFIX}`)).toBe(false);

    sink.out.write(' and the second');
    const bytes = await sink.commit();

    expect(await readdir(dir)).toEqual([NAME]);
    expect(await readFile(join(dir, NAME), 'utf8')).toBe('the first half and the second');
    expect(bytes).toBe('the first half and the second'.length);
  });

  it('reports the size measured from the file, not from what was written', async () => {
    // Counting bytes as they go past would report a full backup for a stream that was cut short by
    // a full disk. The number has to come from the artefact.
    const sink = await adapter().begin(NAME);
    sink.out.write(Buffer.alloc(5000, 0x41));
    expect(await sink.commit()).toBe(5000);
  });

  it('leaves nothing behind when the export fails part-way', async () => {
    const sink = await adapter().begin(NAME);
    sink.out.write('an export that is about to throw');
    await sink.abort();
    expect(await readdir(dir)).toEqual([]);
  });

  it('abort never throws, even called twice or on a vanished directory', async () => {
    // It runs on the failure path. A second failure raised over the first buries the real error.
    const sink = await adapter().begin(NAME);
    sink.out.write('x');
    await sink.abort();
    await expect(sink.abort()).resolves.toBeUndefined();

    const orphan = await adapter().begin('alayra-nexus-backup-2026-08-02-04-00-00.nxb');
    await rm(dir, { recursive: true, force: true });
    await expect(orphan.abort()).resolves.toBeUndefined();
  });
});

describe('preparing the destination', () => {
  it('creates the folder, including parents that do not exist yet', async () => {
    const nested = join(dir, 'a', 'b', 'backups');
    await destinationAdapter({ kind: 'directory', path: nested }).ensure();
    expect(await readdir(nested)).toEqual([]);
  });

  it('is safe to call before every run, not just once', async () => {
    // Called per run on purpose: a network mount that vanished between two nightly backups must
    // fail the run that follows it, rather than stay "verified" from boot.
    const a = adapter();
    await a.ensure();
    await expect(a.ensure()).resolves.toBeUndefined();
  });

  it('refuses a path that is a file, and names the path in the message', async () => {
    const file = join(dir, 'not-a-folder');
    await writeFile(file, 'x');
    await expect(destinationAdapter({ kind: 'directory', path: file }).ensure())
      .rejects.toThrow(new RegExp(file.replace(/\\/g, '\\\\')));
  });
});

describe('listing and removing', () => {
  it('lists what is there and removes by name', async () => {
    const a = adapter();
    await a.ensure();
    await (await a.begin(NAME)).commit();
    await writeFile(join(dir, 'someone-elses-file.zip'), 'x');

    // Everything is listed — deciding which files are OURS is `prunable`'s job, and splitting that
    // judgement across two modules is how a retention sweep learns to delete the wrong thing.
    expect((await a.list()).sort()).toEqual([NAME, 'someone-elses-file.zip']);

    await a.remove(NAME);
    expect(await a.list()).toEqual(['someone-elses-file.zip']);
  });

  it('removing something that is already gone is not an error', async () => {
    // Two replicas can reach the same retention sweep; the loser must not turn that into a failed
    // backup run.
    const a = adapter();
    await a.ensure();
    await expect(a.remove(NAME)).resolves.toBeUndefined();
  });

  it('answers with nothing for a directory that does not exist', async () => {
    // Called during retention, which must not raise over a destination that has gone away — the
    // export failing is the honest error, not the tidy-up after it.
    expect(await destinationAdapter({ kind: 'directory', path: join(dir, 'nope') }).list()).toEqual([]);
  });
});

describe('a destination that cannot be written to', () => {
  it('fails when the backup BEGINS, not later on a stream nobody is listening to', async () => {
    // createWriteStream opens asynchronously. Before `begin` awaited the descriptor, this rejected
    // nowhere useful: the failure arrived as an 'error' event on a stream the runner had not
    // attached a handler to yet, and an unhandled 'error' on a stream ends the process. Losing the
    // gateway because a backup folder was unwritable is a far worse outcome than a missed backup.
    await expect(destinationAdapter({ kind: 'directory', path: join(dir, 'never-created') }).begin(NAME))
      .rejects.toThrow();
  });
});

describe('a write that fails after the file is open', () => {
  it('fails the COMMIT rather than the process', async () => {
    // Vitest reported this as an unhandled error before the sink held its own error listener:
    // `writeBackup` attaches one only while awaiting drain, so a failure at any other moment — a
    // full disk, a mount going away mid-export — was an 'error' event with nobody listening, which
    // Node escalates to an uncaught exception. A gateway that dies because a backup ran out of disk
    // has turned a missed backup into an outage.
    const sink = await adapter().begin(NAME);
    sink.out.write('a good start');

    sink.out.destroy(new Error('the disk filled up'));
    await expect(sink.commit()).rejects.toThrow(/the disk filled up/);

    // And nothing was left behind wearing a backup's name.
    expect(await readdir(dir)).not.toContain(NAME);
  });
});
