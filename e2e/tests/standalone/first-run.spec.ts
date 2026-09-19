import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { STANDALONE_ADMIN_PASSWORD, STANDALONE_MOCK_URL } from '../../setup/standalone';

const OWNER = {
  name: 'Standalone Owner',
  email: 'owner@standalone.test',
  password: 'standalone-owner-password-2026',
};

test('first run reaches a provider, records usage, and works on mobile', async ({ page, request }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByPlaceholder('ADMIN_PASSWORD')).toBeVisible();
  await page.getByPlaceholder('ADMIN_PASSWORD').fill(STANDALONE_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByPlaceholder('Ada Lovelace').fill(OWNER.name);
  await page.getByPlaceholder('you@company.com').fill(OWNER.email);
  await page.getByPlaceholder('Your new password').fill(OWNER.password);
  await page.getByPlaceholder('Type it again').fill(OWNER.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Name your workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Protect your backups')).toBeVisible();
  const passphrase = (await page.locator('code').first().textContent())?.trim();
  expect(passphrase?.split('-')).toHaveLength(8);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByText('Your owner account is ready.')).toBeVisible();
  await page.getByPlaceholder(/copper-lantern-drift/i).fill(passphrase!);
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.goto('/nexus');
  await page.getByRole('button', { name: 'Add provider' }).first().click();
  const providerDialog = page.getByRole('dialog');
  await providerDialog.getByLabel('Display name').fill('Local Mock');
  await providerDialog.getByLabel('Upstream provider').selectOption('custom');
  await providerDialog.getByLabel('Base URL').fill(`${STANDALONE_MOCK_URL}/v1`);
  await providerDialog.getByRole('button', { name: 'Create pool' }).click();
  await expect(providerDialog).toBeHidden();
  await expect(page.getByText('Local Mock', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Key', exact: true }).click();
  const keyDialog = page.getByRole('dialog');
  await keyDialog.getByLabel('API key').fill('sk-standalone-mock');
  await keyDialog.getByRole('button', { name: 'Fetch models' }).click();
  await keyDialog.getByRole('button', { name: 'mock-model-1' }).click();
  await keyDialog.getByLabel('Label').fill('primary');
  await keyDialog.getByRole('button', { name: 'Add key' }).click();
  await expect(keyDialog).toBeHidden();
  await expect(page.getByText('mock-model-1', { exact: true })).toBeVisible();

  const dataDir = process.env.NEXUS_STANDALONE_E2E_DATA_DIR;
  expect(dataDir, 'global setup must expose its isolated data directory').toBeTruthy();
  const apiKey = readFileSync(path.join(dataDir!, 'api-key.txt'), 'utf8').trim();
  const completion = await request.post('/v1/chat/completions', {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      model: 'mock-model-1',
      messages: [{ role: 'user', content: 'Reply through the standalone route.' }],
    },
  });
  expect(completion.status()).toBe(200);
  expect((await completion.json()).choices[0].message.content).toBe('The mock provider answers.');

  await expect(async () => {
    await page.goto('/analytics');
    await expect(page.getByText('mock-model-1', { exact: true }).first()).toBeVisible();
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });

  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Benchmarks' })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Enterprise')).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
