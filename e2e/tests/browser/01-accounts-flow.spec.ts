import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN_PASSWORD } from '../../setup/stacks';
import { UI_OWNER as OWNER } from '../../helpers/personas';
import { totpCode } from '../../helpers/totp';
import { saveState } from '../../helpers/state';

// The accounts story again — but through a REAL browser against the REAL dashboard bundle,
// served by the same compiled gateway a deployment runs. This is the suite that would have
// caught the last three shipped bugs, each of which was found by a human clicking: the
// dashboard's fetch layer, its dead links, and its error rendering are all in the loop here,
// none of which any amount of API testing can see.
//
// One browser context is shared across the whole story (the session token lives in
// sessionStorage, which Playwright's per-test isolation would silently drop), and a second,
// separate context plays the invited colleague — two people, two browsers, one gateway.
test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let page: Page;           // the owner's browser
let colleague: BrowserContext;
let colleaguePage: Page;  // the invitee's browser
let inviteLink = '';
let totpSecret = '';

const INVITEE = { name: 'Liaqat', email: 'liaqat@ui.alayra.com', password: 'liaqat-passphrase-ui-1' };

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  colleague = await browser.newContext();
  colleaguePage = await colleague.newPage();
});

test.afterAll(async () => {
  await ctx.close();
  await colleague.close();
});

test('a fresh gateway greets its installer with the setup screen, not a sign-in', async () => {
  await page.goto('/');
  // The claim screen asks for the one thing only the installer has (step 1 of the wizard).
  await expect(page.getByPlaceholder('ADMIN_PASSWORD')).toBeVisible();
});

test('claiming creates the owner and shows the recovery key exactly once', async () => {
  // Step 1 — prove ownership.
  await page.getByPlaceholder('ADMIN_PASSWORD').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2 — the account, including confirm-password.
  await page.getByPlaceholder('Ada Lovelace').fill(OWNER.name);
  await page.getByPlaceholder('you@company.com').fill(OWNER.email);
  await page.getByPlaceholder('Your new password').fill(OWNER.password);
  await page.getByPlaceholder('Type it again').fill(OWNER.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3 — workspace name is optional; leave it blank and finish.
  await expect(page.getByText('Name your workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Create owner account' }).click();

  await expect(page.getByText('Your owner account is ready.')).toBeVisible();
  // The recovery key is on screen, in the hyphenated shape a person can write down.
  await expect(page.getByText(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/)).toBeVisible();

  await page.getByRole('button', { name: 'I’ve saved my recovery key — continue' }).click();
  await expect(page.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('sign out, and back in with email and password', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByPlaceholder('you@company.com')).toBeVisible();

  await page.getByPlaceholder('you@company.com').fill(OWNER.email);
  await page.getByPlaceholder('Your password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('two-factor setup completes in a real browser', async () => {
  // The exact flow from the bug report that started P7.13a-fix: this button used to answer
  // with FST_ERR_CTP_EMPTY_JSON_BODY in red, because the dashboard's fetch layer sent a
  // Content-Type header with no body behind it. Only a real browser exercises that layer.
  await page.goto('/security');
  await page.getByRole('button', { name: 'Set up two-factor' }).click();

  // Enrolment leads with a scannable QR (7.15b); a real authenticator would scan it. This headless
  // test can't, so it takes the "enter by hand" path to the base32 key — the same fallback a user
  // without a camera would. The QR being present is asserted in the web unit suite.
  await page.getByRole('button', { name: /enter the key by hand/i }).click();

  // The setup key an authenticator app would be given — base32, shown once.
  const secretEl = page.getByText(/^[A-Z2-7]{32}$/);
  await expect(secretEl).toBeVisible();
  totpSecret = (await secretEl.textContent()) ?? '';
  // 02-sessions-gating-reset signs in as this owner later, in a fresh worker — persist the
  // secret it will need to play the authenticator, because the gateway shows it only once.
  saveState('ui-owner-totp', totpSecret);

  // Play the authenticator: compute the 6-digit code the app would show right now.
  await page.getByPlaceholder('123456').fill(totpCode(totpSecret));
  await page.getByRole('button', { name: 'Confirm & enable' }).click();

  // The moment of truth is the show-once screen: fresh recovery codes, never displayed again.
  await expect(page.getByText(/Save these recovery codes now/i)).toBeVisible();
});

test('the owner invites a colleague and is handed the link exactly once', async () => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Invite' }).click();
  await page.getByPlaceholder('them@company.com').fill(INVITEE.email);
  await page.getByRole('button', { name: 'Create invite' }).click();

  await expect(page.getByText(`Send this link to ${INVITEE.email}`)).toBeVisible();
  const box = page.getByText(/\/invite\?token=/);
  inviteLink = (await box.textContent()) ?? '';
  expect(inviteLink).toContain('/invite?token=');
  await page.getByRole('button', { name: 'Done' }).click();
});

test('the colleague accepts in their own browser and lands signed in', async () => {
  await colleaguePage.goto(inviteLink);
  await colleaguePage.getByPlaceholder('Ada Lovelace').fill(INVITEE.name);
  await colleaguePage.getByPlaceholder('Your new password').fill(INVITEE.password);
  await colleaguePage.getByPlaceholder('Type it again').fill(INVITEE.password);
  await colleaguePage.getByRole('button', { name: 'Create account' }).click();

  // Their own recovery key, their own once.
  await expect(colleaguePage.getByText(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/)).toBeVisible();
  await colleaguePage.getByRole('button', { name: /continue/i }).click();
  await expect(colleaguePage.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('suspension throws the colleague out on their very next click', async () => {
  await page.goto('/admin');
  const row = page.getByRole('row', { name: new RegExp(INVITEE.email) });
  await row.getByRole('button', { name: 'Suspend' }).click();
  await expect(row.getByText('Suspended')).toBeVisible();

  // Their session token is the one that worked a moment ago. The next navigation must not
  // honour it — resolveSession reads the account on every request, so there is no window
  // where yesterday's authority is still walking around.
  await colleaguePage.goto('/teams');
  await expect(colleaguePage.getByPlaceholder('you@company.com')).toBeVisible();
});

test('removal takes the person out of the table, and the trail survives them', async () => {
  const row = page.getByRole('row', { name: new RegExp(INVITEE.email) });
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove account' }).click();

  await expect(page.getByRole('row', { name: new RegExp(INVITEE.email) })).toHaveCount(0);

  // The record outlives the account: the audit trail still names them. Audit writes are
  // pipelined (batched inserts, drained on shutdown), so the newest entries can lag the
  // page by a flush interval — reload until they land rather than racing the pipeline.
  await expect(async () => {
    await page.goto('/logs');
    await expect(page.getByText(INVITEE.name).first()).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
});
