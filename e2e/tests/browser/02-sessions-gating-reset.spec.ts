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
import { ADMIN_PASSWORD } from '../../setup/stacks';
import { UI_OWNER as OWNER } from '../../helpers/personas';
import { totpCode } from '../../helpers/totp';
import { loadState } from '../../helpers/state';

// P7.13b through a real browser: the identity in the topbar, the sessions panel, what a
// viewer is and is not shown, and finally the factory reset — which ends with the same
// setup screen the whole browser story began on. LAST file in this project on purpose:
// nothing can run against this stack after it is wiped.
test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let page: Page;         // the owner's browser
let viewerCtx: BrowserContext;
let viewerPage: Page;   // a viewer's browser
let inviteLink = '';

const VIEWER = { name: 'Vera', email: 'vera@ui.alayra.com', password: 'vera-passphrase-ui-1' };

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  viewerCtx = await browser.newContext();
  viewerPage = await viewerCtx.newPage();
});

test.afterAll(async () => {
  await ctx.close();
  await viewerCtx.close();
});

test('the owner signs in — password first, then the code 2FA now demands', async () => {
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(OWNER.email);
  await page.getByPlaceholder('Your password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // 01 enrolled this owner; play the authenticator with the secret it persisted.
  await page.getByPlaceholder('123456').fill(totpCode(loadState('ui-owner-totp')));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('the topbar names the person, their role, and a LIVE pill that actually polled', async () => {
  // Until 7.13b this read "LIVE · A · Admin" regardless of who signed in or whether the
  // gateway was up: a hardcoded word and a placeholder name.
  // exact: the Overview behind it also says "Live" in its status card.
  await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
  // Scope the name to the topbar (banner): since 7.15c the owner's name also appears in every
  // Recent Activity row they acted in, so a whole-page getByText(name) is now ambiguous — which
  // is exactly the feature working. The topbar is what this test is actually about.
  const topbar = page.getByRole('banner');
  await expect(topbar.getByText(OWNER.name)).toBeVisible();
  await expect(topbar.getByText('Owner', { exact: true })).toBeVisible();
});

test('the Connect page verifies its address against this very browser (P7.14)', async () => {
  // This stack has no PUBLIC_URL pin and no proxy: the server infers its address from the Host
  // header, and this browser reached it at exactly that address — the page must say so.
  await page.goto('/connect');
  await expect(page.getByText(/Address verified/)).toBeVisible();
  await expect(page.getByText(/inferred from the request/)).toBeVisible();
});

test('the sessions panel shows this device, and sign-out-everywhere spares it', async () => {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'My account' }).click();

  await expect(page.getByText("Where you're signed in")).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();

  // Earlier sign-ins (01's story, and password-only steps) may have left other sessions.
  // If any are listed, one click ends them all — and this browser keeps working.
  const revokeOthers = page.getByRole('button', { name: 'Sign out everywhere else' });
  if (await revokeOthers.isVisible()) {
    await revokeOthers.click();
    await expect(page.getByText('Only this device')).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('the owner invites a viewer, who accepts in their own browser', async () => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Invite' }).click();
  // The role select already defaults to viewer — the least, which is the point of a default.
  await page.getByPlaceholder('them@company.com').fill(VIEWER.email);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const box = page.getByText(/\/invite\?token=/);
  inviteLink = (await box.textContent()) ?? '';
  await page.getByRole('button', { name: 'Done' }).click();

  await viewerPage.goto(inviteLink);
  await viewerPage.getByPlaceholder('Ada Lovelace').fill(VIEWER.name);
  await viewerPage.getByPlaceholder('Your new password').fill(VIEWER.password);
  await viewerPage.getByPlaceholder('Type it again').fill(VIEWER.password);
  await viewerPage.getByRole('button', { name: 'Create account' }).click();
  await viewerPage.getByRole('button', { name: /continue/i }).click();
  await expect(viewerPage.getByRole('link', { name: 'Alayra Nexus — Overview' })).toBeVisible();
});

test('the viewer sees the gateway but is offered nothing that would change it', async () => {
  // Their topbar is honest about who and what they are.
  await expect(viewerPage.getByText(VIEWER.name)).toBeVisible();
  await expect(viewerPage.getByText('Viewer', { exact: true })).toBeVisible();

  // Admin: the people are visible, managing them is not — and there is no Danger zone tab.
  await viewerPage.goto('/admin');
  await expect(viewerPage.getByText(OWNER.email)).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Invite' })).not.toBeVisible();
  await expect(viewerPage.getByRole('tab', { name: 'Danger zone' })).not.toBeVisible();

  // Settings: the fields load, the save is a sentence instead of a button.
  await viewerPage.goto('/settings');
  await expect(viewerPage.getByText(/read-only access/i).first()).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Save changes' })).not.toBeVisible();
});

test('the factory reset asks for both proofs, then lands on the setup screen', async () => {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Danger zone' }).click();

  const eraseButton = page.getByRole('button', { name: /erase everything and reset/i });
  await expect(eraseButton).toBeDisabled();

  // The password alone does not arm it; the phrase must match to the letter.
  await page.getByLabel(/administrator master password/i).fill(ADMIN_PASSWORD);
  await expect(eraseButton).toBeDisabled();
  await page.getByLabel(/type reset this gateway/i).fill('reset this gateway');
  await expect(eraseButton).toBeDisabled();
  await page.getByLabel(/type reset this gateway/i).fill('RESET THIS GATEWAY');
  await expect(eraseButton).toBeEnabled();

  await eraseButton.click();
  // The story ends where it began: an unclaimed gateway offering the setup screen.
  await expect(page.getByPlaceholder('ADMIN_PASSWORD')).toBeVisible();
});

test('the reset signed the viewer out too — their session died with everything else', async () => {
  await viewerPage.reload();
  // Their token is dead and their account is gone; the app can only offer first-run setup.
  await expect(viewerPage.getByPlaceholder('ADMIN_PASSWORD')).toBeVisible();
});
