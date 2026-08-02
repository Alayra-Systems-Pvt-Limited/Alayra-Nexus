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

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { UI_OWNER as OWNER } from '../../helpers/personas';
import { totpCode } from '../../helpers/totp';
import { loadState } from '../../helpers/state';

// The Backup panel (B1.4) driven by a real browser: an operator types a passphrase, receives an
// actual file on their disk, and hands that same file back to the wizard.
//
// ── What this covers that 07-backup.spec.ts cannot ────────────────────────────────────────────
//
// The API spec proves the gateway's half over the wire. Two things live only in the browser and are
// invisible to it.
//
// The first is the CONFIRM field. The server is sent one passphrase and can never know whether the
// operator typed what they meant — a single typo produces a file that nobody, including them, can
// ever open, and nothing downstream can detect it. The second field is the only defence that exists
// anywhere in the system, so it is worth proving it actually holds the button shut.
//
// The second is the download itself: a POST whose response is turned into a Blob and clicked
// through an anchor. `downloadBackup` never returns bytes to the caller, so a unit test can assert
// that it was called and nothing more. Whether a file with contents lands on a disk is a question
// only a browser can answer.
//
// ── 01b-, between the accounts story and the reset ────────────────────────────────────────────
//
// After 01, which claims the gateway and enrols the owner's second factor. Before 02, which factory-
// resets this stack and must stay last. Nothing here writes: the wizard is driven as far as the dry
// run, which reads the whole file, authenticates it and deliberately stores none of it. Restoring
// for real is 07's job, on the stack that can afford it.
test.describe.configure({ mode: 'serial' });

const PASSPHRASE = 'ui-backup-passphrase-2026';

let ctx: BrowserContext;
let page: Page;

/** Where Playwright spooled the downloaded backup, and what the browser called it. */
let downloadedPath = '';
let downloadedName = '';

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ acceptDownloads: true });
  page = await ctx.newPage();
});

test.afterAll(async () => {
  await ctx.close();
});

test('the owner signs in and finds Backup where an owner would look for it', async () => {
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(OWNER.email);
  await page.getByPlaceholder('Your password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // 01 enrolled this owner; play the authenticator with the secret it persisted.
  await page.getByPlaceholder('123456').fill(totpCode(loadState('ui-owner-totp')));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();

  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Backup' }).click();

  // Both cards, on one screen and in the order the work happens. A restore is only ever as good as
  // the backup nobody took, and an operator who has never pressed the top button should see that.
  await expect(page.getByRole('heading', { name: 'Take a backup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible();
});

test('the button stays shut until the passphrase is long enough AND typed twice', async () => {
  const download = page.getByRole('button', { name: 'Download backup' });
  const first = page.getByPlaceholder('Something you will still have in a year');
  const again = page.getByPlaceholder('Confirm the passphrase');

  await expect(download).toBeDisabled();

  // Under twelve characters the card says how many are left, rather than "invalid".
  await first.fill('short');
  await expect(page.getByText('Use at least 12 characters')).toBeVisible();
  await expect(download).toBeDisabled();

  // Long enough, but the second field is empty — still shut. The server would have accepted this
  // request happily; it has no way to know the operator only typed the passphrase once.
  await first.fill(PASSPHRASE);
  await expect(download).toBeDisabled();

  // A typo in the confirmation is THE failure this field exists for: it produces a file that will
  // not open on the day it is needed, and no later check anywhere in the system can catch it.
  await again.fill(`${PASSPHRASE}x`);
  await expect(page.getByText('These two don’t match.')).toBeVisible();
  await expect(download).toBeDisabled();

  // Matching, and only now.
  await again.fill(PASSPHRASE);
  await expect(page.getByText('These two don’t match.')).toBeHidden();
  await expect(download).toBeEnabled();
});

test('pressing it puts a real, sealed file on the operator’s disk', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup' }).click(),
  ]);

  downloadedName = download.suggestedFilename();
  downloadedPath = (await download.path()) ?? '';

  // The name comes from the gateway's content-disposition, not from the browser guessing — a file
  // called `export` with no extension is one an operator cannot identify a year later.
  expect(downloadedName).toMatch(/^alayra-nexus-backup-[\d-]+\.nxb$/);
  expect(downloadedPath, 'the browser must have written a file').not.toBe('');

  const bytes = readFileSync(downloadedPath);
  expect(bytes.length).toBeGreaterThan(0);

  // Same shape 07 asserts over the wire, checked here on the artefact that actually reached the
  // disk. `blob()` and the anchor sit between the response and this file, and a backup that is
  // whole on the socket and truncated on disk is exactly the failure that would be discovered on
  // the day it was needed.
  const newline = bytes.indexOf(0x0a);
  expect(newline).toBeGreaterThan(0);
  const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as {
    format: string; version: number; recipients: { type: string }[];
  };
  expect(header.format).toBe('alayra-nexus-backup');
  expect(header.version).toBe(1);
  expect(header.recipients.map((r) => r.type)).toContain('passphrase');

  // The card confirms the exact filename, and says the thing an operator most needs to hear.
  await expect(page.getByRole('status')).toContainText(downloadedName);
  await expect(page.getByText('a backup on the same disk as the gateway is lost by the same accident'))
    .toBeVisible();

  // The passphrase is cleared from the form afterwards — it is not left sitting in a field on a
  // screen an operator may walk away from.
  await expect(page.getByPlaceholder('Something you will still have in a year')).toHaveValue('');
});

test('handing that same file back, the wizard reads it and reports what a restore would do', async () => {
  // The round trip, through the browser: the file this page produced is now its own input. The
  // input is click-driven and hidden behind "Browse for a backup", which `setInputFiles` addresses
  // directly — driving the OS file chooser is not something a browser test can or should do.
  await page.locator('input[type="file"]').setInputFiles(downloadedPath);
  await expect(page.getByText(downloadedName)).toBeVisible();

  await page.getByPlaceholder('The passphrase for this file').fill(PASSPHRASE);

  const check = page.getByRole('button', { name: 'Check this backup' });
  await expect(check).toBeEnabled();
  await check.click();

  // Reads and authenticates the whole file. The report is the proof that every layer between this
  // browser and the database agreed: the blob, the multipart upload, the cipher and the codec.
  //
  // Anchored on the tile's sub-line, which is unique to it. "Rows in the file" alone is not: the
  // per-table breakdown lower down uses the same words as a column header, so matching on the label
  // resolves to two elements and Playwright rightly refuses to guess which was meant.
  const tile = page.getByText(/^across \d+ tables?$/).locator('..');
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await expect(tile).toContainText('Rows in the file');

  // A real count, not a placeholder or a dash. This gateway has an owner, a colleague, teams and
  // settings in it by now, so a file reporting zero rows would mean the export walked an empty
  // model list and the panel drew it without complaint. The value is rendered exactly — "1.2K rows"
  // is the wrong unit for a decision about data loss — so the comma is the only thing to strip.
  const shown = /\n([\d,]+)\n/.exec(await tile.innerText())?.[1] ?? '0';
  expect(Number(shown.replace(/,/g, ''))).toBeGreaterThan(10);

  // The wizard has moved on, and now offers the thing it would not offer before the check: an
  // operator cannot reach a restore without first having been shown what it would do.
  await expect(page.getByRole('button', { name: 'Merge this backup in' })).toBeVisible();
});

// ── The archive the gateway keeps of itself (B2) ──────────────────────────────
//
// Everything above is a file leaving through the browser and coming back. This is the other half:
// the backups the gateway holds on its own behalf, and the card that is the only way an operator on
// a hosted platform can ever reach one — there is no filesystem for them to log into.
//
// The three states of the data-loss notice are unit-tested next to the component, because two of
// them cannot be reached by a running gateway (`off-machine` needs object storage, which is B3).
// What is checked here is the one that a real operator actually meets on day one, on a real page,
// with real backups underneath it.

/** A stored backup's name, which is also how its row is found — the meta line follows it. */
const BACKUP_NAME = /alayra-nexus-backup-\d{4}(-\d{2}){5}\.nxb/;

test('the backups card warns, in red, that these live in the database they protect', async () => {
  await page.reload();
  await page.getByRole('tab', { name: 'Backup' }).click();

  await expect(page.getByRole('heading', { name: 'Your backups' })).toBeVisible();

  // Nothing has been configured on this gateway, so the notice must be at full strength. It is an
  // `alert` rather than a note, which is what makes a screen reader announce it rather than leave it
  // to be discovered.
  const notice = page.getByRole('alert').filter({ hasText: 'Download these' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('no second copy on our side');
  // And it names the way out in the words of the control that provides it.
  await expect(notice).toContainText('Keep a copy off this machine');

  // An empty archive says how to stop being empty, rather than only that it is.
  await expect(page.getByText('No backups yet')).toBeVisible();
});

test('pressing “Back up now” puts a real backup in the list, marked as taken by hand', async () => {
  test.setTimeout(120_000);

  await page.getByRole('button', { name: /Back up now/i }).click();

  // The row is the whole point of B2: before it, a backup the gateway took could only be retrieved
  // by somebody with access to the server, which on a hosted platform is nobody at all.
  const row = page.locator('li', { hasText: BACKUP_NAME }).first();
  await expect(row).toBeVisible({ timeout: 90_000 });

  // `origin`, rendered. This is the distinction that answers "did the schedule actually fire, or is
  // every backup here one I took myself?" — and a button press has to say the honest answer.
  await expect(row).toContainText('Taken by hand');
  await expect(page.getByText('1 backup')).toBeVisible();
});

test('the backup downloads from the list, with the session token a plain link could not carry', async () => {
  const row = page.locator('li', { hasText: BACKUP_NAME }).first();
  const name = (await row.locator('span').first().innerText()).trim().split('\n')[0];

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: /Download/i }).click(),
  ]);

  // The route is owner-only and authenticated by a bearer token held in memory, so this cannot be an
  // <a href> — a browser navigation carries no Authorization header and would arrive as a 401. The
  // file is fetched with the header attached and handed over as a blob, and only a real browser can
  // prove that the blob becomes a file.
  expect(download.suggestedFilename()).toBe(name);

  const path = (await download.path()) ?? '';
  expect(path, 'the browser must have written a file').not.toBe('');

  const bytes = readFileSync(path);
  const newline = bytes.indexOf(0x0a);
  expect(newline).toBeGreaterThan(0);
  const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as {
    format: string; recipients: { type: string }[];
  };
  expect(header.format).toBe('alayra-nexus-backup');

  // Taken with nobody present to type anything, so it is wrapped for the gateway and for the
  // recovery key the setup wizard created — and for no passphrase at all.
  const types = header.recipients.map((r) => r.type);
  expect(types).not.toContain('passphrase');
  expect(types).toContain('gateway');
  expect(types).toContain('recovery');
});

test('deleting it from the list removes it, and the card goes back to being empty', async () => {
  const row = page.locator('li', { hasText: BACKUP_NAME }).first();
  const name = (await row.locator('span').first().innerText()).trim().split('\n')[0];

  await page.getByRole('button', { name: `Delete ${name}` }).click();

  // Scoped to the list, not the page. The schedule card below reports the LAST RUN by name, and it
  // still says so afterwards — correctly: deleting the file does not rewrite the fact that a backup
  // was taken at that moment. Asserting the name is gone from the whole page would be asserting the
  // gateway lies about its own history.
  await expect(page.locator('li', { hasText: BACKUP_NAME })).toHaveCount(0);
  await expect(page.getByText('No backups yet')).toBeVisible();

  // 02-sessions-gating-reset runs next and factory-resets this stack; leaving a backup behind is
  // harmless, but leaving the panel in a state nothing asserted is how a later failure gets blamed
  // on the wrong spec.
  await expect(page.getByRole('alert').filter({ hasText: 'Download these' })).toBeVisible();
});
