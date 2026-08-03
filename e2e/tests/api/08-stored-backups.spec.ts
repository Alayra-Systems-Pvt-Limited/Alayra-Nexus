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

import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The gateway backing itself up while nobody is watching (Phase B2), end to end.
//
// ── The claim nothing has ever checked ────────────────────────────────────────────────────────
//
// 07 proves an operator can take a backup and give it back. Every part of that is a person pressing
// something. The whole point of B2 is the case where nobody does: a timer fires at 03:00, a file
// lands in the database, and months later it is the only copy that exists. Between shipping and now
// there was no test at any level that the timer ever fires — the runner's own suite covers what is
// *owed* and what a schedule may be *saved as*, and stops before anything runs.
//
// So this spec waits for a real backup to appear that no request in it asked for. That is slow and
// it is the point: a scheduled backup is not something that can be simulated into existence and
// still mean anything.
//
// ── Why the unattended file is the interesting one ────────────────────────────────────────────
//
// It carries no passphrase recipient — there was nobody to type one. It is wrapped for the gateway
// and for the recovery key created at claim, and that second recipient is the only thing that can
// open it once the machine is gone. This spec hands the file straight back to the gateway with NO
// passphrase at all, which is a route 07 cannot exercise and the exact operation an unattended
// backup exists to make possible.
//
// ── 08-, on purpose ───────────────────────────────────────────────────────────────────────────
//
// After 07, whose `replace` restore rewrites every table — including the settings this spec writes a
// schedule into. Before 98-reset, which destroys everything. Stored backups are excluded from backup
// and restore by design, so nothing 07 does can put one here.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

/** Where a scheduled run appears. `origin` is the field that answers "did the timer actually fire?" */
interface Archived {
  filename: string;
  createdAt: string;
  bytes: number;
  rows: number;
  origin: string;
}

interface Overview {
  schedule: { enabled: boolean; keep: number; hourUtc: number; minuteUtc: number };
  state: { lastRunAt: number | null };
}

/** The runner wakes once a minute, so a due schedule lands inside two ticks with room to spare. */
const TICK_BUDGET_MS = 150_000;

/**
 * Wait until the wall clock's second turns over.
 *
 * A backup's name IS its timestamp to the second, and it is unique — so two runs finishing inside
 * one second ask for the same name, and the gateway refuses the later one (`beginStoredBackup`).
 * That refusal is correct and deliberate; this spec simply must not trip over it. Crossing a second
 * boundary guarantees a name distinct from every backup taken up to now, which a fixed sleep only
 * approximates.
 *
 * Found the hard way, twice. The second time was on main: the scheduled run below is detected by
 * POLLING, and the poll can return inside the very second the timer wrote its file — so "the
 * scheduled backup happened much earlier" was an assumption rather than a fact, and CI failed on it
 * with the two filenames identical.
 */
async function nextSecond(): Promise<void> {
  const started = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === started) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let ownerToken = '';

/** The unattended backup, held across the spec — every later test reads the one the gateway took. */
let scheduled: Archived | undefined;

const archive = async (token = ownerToken): Promise<Archived[]> => {
  const res = await gw.get<{ backups: Archived[] }>('/admin/backup/archive', token);
  return res.status === 200 ? res.body.backups : [];
};

test.beforeAll(async () => {
  ownerToken = await gw.login(OWNER.email, OWNER.password);
});

// ── Arming it ─────────────────────────────────────────────────────────────────

test('the archive starts empty, so anything in it later got there on its own', async () => {
  // The baseline the rest of the spec depends on. Without it, a backup left behind by another spec
  // would satisfy every assertion below and prove nothing.
  expect(await archive()).toEqual([]);
});

test('the owner switches on a nightly schedule that is already overdue', async () => {
  // Midnight UTC, every day: whatever time CI runs at, the most recent window has passed and no run
  // has ever satisfied it, so the very next tick owes a backup. Nothing here fakes a clock — the
  // gateway is genuinely behind and genuinely catches up.
  const res = await gw.send<Overview>('PUT', '/admin/backup/schedule', {
    token: ownerToken,
    body: {
      enabled: true, everyDays: 1, hourUtc: 0, minuteUtc: 0,
      // Two, so retention has something to do later without a third run.
      keep: 2,
      copyOffMachine: false,
      destination: { kind: 'directory', path: '' },
    },
  });

  expect(res.status).toBe(200);
  expect(res.body.schedule.enabled).toBe(true);
  // Enabling at all requires the backup recovery key, which is why 01-first-run claims with a
  // passphrase. A 400 here means that line went missing, not that the schedule is wrong.
  expect(res.body.state.lastRunAt).toBeNull();
});

// ── The part that has never been proved ───────────────────────────────────────

test('the gateway takes a backup with nobody asking it to', async () => {
  test.setTimeout(TICK_BUDGET_MS + 60_000);

  // No request is made here. The gateway's own timer is what has to produce this, and the only
  // honest way to observe that is to wait for it.
  await expect.poll(
    async () => (await archive()).length,
    {
      message: 'the scheduler never fired — no backup appeared without one being asked for',
      timeout: TICK_BUDGET_MS,
      intervals: [2_000],
    },
  ).toBe(1);

  [scheduled] = await archive();

  // `origin` exists precisely so an operator can answer "did the schedule actually fire, or is every
  // backup here one I took by hand?". This is the assertion that makes the field mean something.
  expect(scheduled!.origin).toBe('scheduled');
  expect(scheduled!.filename).toMatch(/^alayra-nexus-backup-\d{4}(-\d{2}){5}\.nxb$/);

  // A real gateway with seven specs of history behind it. A backup reporting a handful of rows would
  // mean the unattended path exported something quite different from what /export walks.
  expect(scheduled!.rows).toBeGreaterThan(10);
  expect(scheduled!.bytes).toBeGreaterThan(0);

  // And the run was recorded, so the dashboard can say when it last happened.
  const overview = await gw.get<Overview>('/admin/backup/schedule', ownerToken);
  expect(overview.body.state.lastRunAt).toBeGreaterThan(0);
});

// ── Getting it back out ───────────────────────────────────────────────────────

test('it downloads as a real sealed file, wrapped for the gateway and for the recovery key', async () => {
  const res = await gw.download(`/admin/backup/archive/${scheduled!.filename}`, {
    token: ownerToken, method: 'GET',
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${scheduled!.filename}"`);
  // The whole file, reassembled from its chunk rows. A mismatch here means the stored length and the
  // stored bytes disagree, which is a backup that will not open.
  expect(res.bytes.length).toBe(scheduled!.bytes);
  expect(res.headers.get('cache-control')).toContain('no-store');

  const newline = res.bytes.indexOf(0x0a);
  expect(newline, 'a backup must carry a header line').toBeGreaterThan(0);
  const header = JSON.parse(res.bytes.subarray(0, newline).toString('utf8')) as {
    format: string; version: number; recipients: { type: string }[];
  };
  expect(header.format).toBe('alayra-nexus-backup');

  const types = header.recipients.map((r) => r.type);
  // Nobody was there to type one, so there must be no passphrase recipient — and its absence is the
  // reason the other two have to be present.
  expect(types).not.toContain('passphrase');
  expect(types).toContain('gateway');
  // The one that survives the machine. Without it this file could only ever be opened by the server
  // it exists to outlive, which is the failure `writeSchedule` refuses to let an operator create.
  expect(types).toContain('recovery');

  // Still encrypted, checked on the artifact rather than on the promise.
  expect(res.bytes.subarray(newline + 1).includes(Buffer.from(OWNER.email, 'utf8'))).toBe(false);
});

test('the gateway can read back its own unattended backup with no passphrase at all', async () => {
  test.setTimeout(120_000);

  const file = await gw.download(`/admin/backup/archive/${scheduled!.filename}`, {
    token: ownerToken, method: 'GET',
  });

  // No passphrase field. The gateway opens the file with its own recipient — the path an unattended
  // restore takes, and one 07 cannot reach because every file it makes is wrapped for a human.
  const res = await gw.upload<{
    dryRun: boolean; totalRowsInFile: number; totalWritten: number; sourceEngine: string;
    collisions: unknown[]; missingEnv: string[]; error?: string;
  }>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: file.bytes, filename: scheduled!.filename },
    fields: { mode: 'merge', dryRun: 'true' },
  });

  expect(res.status, res.body.error ?? '').toBe(200);
  expect(res.body.dryRun).toBe(true);
  // Read, authenticated and understood end to end. Anything wrong in the unattended export — a
  // truncated stream, a chunk out of order, a trailer never written — surfaces here and nowhere
  // earlier, because this is the first thing that opens the file rather than measuring it.
  expect(res.body.totalRowsInFile).toBe(scheduled!.rows);
  expect(res.body.sourceEngine).toBe('postgres');
  expect(res.body.totalWritten).toBe(0);
  expect(res.body.collisions).toEqual([]);
  expect(res.body.missingEnv).toEqual([]);
});

// ── By hand, and told apart ───────────────────────────────────────────────────

test('“Back up now” stores one too, and it is distinguishable from the one the timer took', async () => {
  test.setTimeout(120_000);

  await nextSecond();

  const res = await gw.post<{ ran: boolean; filename: string; rows: number; error?: string }>(
    '/admin/backup/schedule/run', { token: ownerToken },
  );
  expect(res.status, res.body.error ?? '').toBe(200);
  expect(res.body.ran).toBe(true);

  const all = await archive();
  expect(all).toHaveLength(2);

  const manual = all.find((b) => b.filename === res.body.filename);
  // The distinction the panel shows and the schema comment exists for. Both files are real backups;
  // only one of them means the schedule is working.
  expect(manual?.origin).toBe('manual');
  expect(all.filter((b) => b.origin === 'scheduled')).toHaveLength(1);
});

// ── Retention, and getting rid of one ─────────────────────────────────────────

test('a third backup pushes the oldest out, because keep is two', async () => {
  test.setTimeout(120_000);

  await nextSecond();

  const before = (await archive()).map((b) => b.filename).sort();

  const res = await gw.post<{ ran: boolean; filename: string; pruned: number; error?: string }>(
    '/admin/backup/schedule/run', { token: ownerToken },
  );
  expect(res.status, res.body.error ?? '').toBe(200);
  expect(res.body.pruned).toBe(1);

  const after = (await archive()).map((b) => b.filename).sort();
  expect(after).toHaveLength(2);

  // The OLDEST went, and it is the one that was there first. Retention that removed the newest, or
  // removed an arbitrary one, would still leave a count of two and pass a weaker assertion.
  expect(after).not.toContain(before[0]);
  expect(after).toContain(before[1]);
  expect(after).toContain(res.body.filename);
});

test('a viewer cannot download the gateway’s credentials out of the archive', async () => {
  // The same refusal 07 proves on /export, checked here on the real stack. A stored backup is every
  // provider key, every team key and every TOTP secret in one file; the least credential the gateway
  // issues must not reach it.
  const minted = await gw.post<{ token: { token: string } }>('/admin/tokens', {
    token: ownerToken, body: { name: 'archive-probe', role: 'viewer' },
  });
  const viewerToken = minted.body.token.token;

  const [any] = await archive();

  expect((await gw.get(`/admin/backup/archive`, viewerToken)).status).toBe(403);
  const download = await gw.download(`/admin/backup/archive/${any.filename}`, {
    token: viewerToken, method: 'GET',
  });
  expect(download.status).toBe(403);
});

test('the owner deletes one, and the gateway stops offering it', async () => {
  // The list comes back newest first, so this removes the most recent and keeps the older — the
  // deliberate direction, because retention already covers "the oldest goes" and a delete an
  // operator asks for must obey them rather than the retention rule.
  const [doomed, kept] = await archive();

  const res = await gw.send<{ deleted: string }>('DELETE', `/admin/backup/archive/${doomed.filename}`, {
    token: ownerToken,
  });
  expect(res.status).toBe(200);
  expect(res.body.deleted).toBe(doomed.filename);

  const left = await archive();
  expect(left.map((b) => b.filename)).toEqual([kept.filename]);

  // And it is genuinely gone, not merely hidden from the list — the chunks with it.
  const gone = await gw.download(`/admin/backup/archive/${doomed.filename}`, {
    token: ownerToken, method: 'GET',
  });
  expect(gone.status).toBe(404);
});

test('switching the schedule back off leaves the gateway quiet', async () => {
  // 98-reset runs next and asserts on a gateway nothing is writing to. A timer left armed would keep
  // storing backups underneath it.
  const res = await gw.send<Overview>('PUT', '/admin/backup/schedule', {
    token: ownerToken,
    body: {
      enabled: false, everyDays: 1, hourUtc: 0, minuteUtc: 0, keep: 2,
      copyOffMachine: false, destination: { kind: 'directory', path: '' },
    },
  });
  expect(res.status).toBe(200);
  expect(res.body.schedule.enabled).toBe(false);
});
