import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock, type MockOptions } from './tauriMock';

async function openAbout(page: Page, options: MockOptions) {
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('tab', { name: 'About' }).click();
}
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mock: { calls: string[] } }).__mock.calls);

test('updates are strictly opt-in: nothing is requested until you click', async ({ page }) => {
  await openAbout(page, { updateVersion: '0.2.0' });
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();
  expect(await calls(page)).not.toContain('check_for_update');
  await expect(page.getByText(/never checks for updates by itself/)).toBeVisible();
});

test('check -> install -> restart, with progress', async ({ page }) => {
  await openAbout(page, { updateVersion: '0.2.0' });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('Version 0.2.0 is available.')).toBeVisible();
  await expect(page.getByText(/Faster exports/)).toBeVisible();
  expect(await calls(page)).not.toContain('install_update'); // needs a second, explicit click

  await page.getByRole('button', { name: 'Download and install' }).click();
  await expect(page.getByRole('progressbar', { name: /Downloading version 0.2.0/ })).toBeVisible();
  await expect(page.getByText('Version 0.2.0 is installed.')).toBeVisible();
  await page.getByRole('button', { name: 'Restart Photom' }).click();
  expect(await calls(page)).toContain('restart_app');
});

test('already up to date', async ({ page }) => {
  await openAbout(page, { updateVersion: null });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('You are up to date (version 0.1.0).')).toBeVisible();
});

test('an unreachable update server is explained, not a crash', async ({ page }) => {
  await openAbout(page, {
    errors: {
      check_for_update: {
        code: 'Io',
        message: 'Could not reach the update server. Check your internet connection and try again.',
      },
    },
  });
  await page.getByRole('button', { name: 'Check for updates' }).click();
  const toast = page.getByRole('region', { name: 'Notifications' }).getByRole('alert');
  await expect(toast.getByText('A file could not be read or written.')).toBeVisible();
  await toast.getByText('Show details').click();
  await expect(toast.getByText(/Could not reach the update server/)).toBeVisible();
  // Interacting with a toast must not close the modal dialog behind it.
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
});

test('the licence text is available offline inside the app', async ({ page }) => {
  await openAbout(page, {});
  await page.getByRole('button', { name: 'View licences' }).click();
  await expect(
    page.getByLabel('Licences', { exact: true }).filter({ hasText: 'MIT License' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Hide licences' }).click();
  await expect(page.getByText('MIT License')).toBeHidden();
});
