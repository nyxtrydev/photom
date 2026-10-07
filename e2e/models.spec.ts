import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock, type MockOptions } from './tauriMock';

async function start(page: Page, options: MockOptions = {}) {
  await page.addInitScript(installTauriMock, { hub: { stepMs: 40 }, ...options });
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mock: { calls: string[] } }).__mock.calls);

async function openTab(page: Page, tab: string) {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('tab', { name: tab }).click();
}

const banner = (page: Page) => page.getByTestId('model-install-banner');

test('a feature panel shows the install banner; Install now unlocks it without a restart', async ({
  page,
}) => {
  await start(page);
  await openTab(page, 'Background removal');
  await expect(banner(page)).toContainText(
    'Quality background removal needs a model (about 120 MB total)',
  );
  await expect(banner(page)).toContainText('Works offline after install.');

  await banner(page).getByRole('button', { name: 'Install now' }).click();
  await expect(page.getByRole('progressbar', { name: /Model download progress/ })).toBeVisible();
  await expect(banner(page)).toContainText(/MB of 120 MB, 6\.2 MB\/s, about \d+ s left/);

  await expect(banner(page)).toBeHidden({ timeout: 10000 });
  // Toast with an Open action.
  const toast = page
    .getByRole('status')
    .filter({ hasText: 'Background Remover (Quality) is ready' });
  await expect(toast).toBeVisible();
  expect((await calls(page)).filter((c) => c === 'model_install_many')).toHaveLength(1);
});

test('pause, resume and cancel from the banner', async ({ page }) => {
  await start(page, { hub: { stepMs: 150 } });
  await openTab(page, 'Background removal');
  await banner(page).getByRole('button', { name: 'Install now' }).click();
  await expect(banner(page).getByRole('button', { name: 'Pause' })).toBeVisible();
  await banner(page).getByRole('button', { name: 'Pause' }).click();
  await expect(banner(page)).toContainText(/Paused at \d+(\.\d)? MB/);
  await banner(page).getByRole('button', { name: 'Resume' }).click();
  await expect(banner(page).getByRole('button', { name: 'Pause' })).toBeVisible();
  await banner(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(banner(page).getByRole('button', { name: 'Install now' })).toBeVisible();
});

test('a failed install explains itself and Retry completes it', async ({ page }) => {
  await start(page, { hub: { stepMs: 30, failFirst: { 'bgremoval-quality': 'DiskFull' } } });
  await openTab(page, 'Background removal');
  await banner(page).getByRole('button', { name: 'Install now' }).click();
  await expect(banner(page)).toContainText('could not be installed');
  await expect(banner(page)).toContainText('not enough free disk space');
  await banner(page).getByRole('button', { name: 'Retry' }).click();
  await expect(banner(page)).toBeHidden({ timeout: 10000 });
});

test('a model that is not published yet cannot be installed', async ({ page }) => {
  await start(page, { hub: { unpublished: ['bgremoval-quality'] } });
  await openTab(page, 'Background removal');
  await expect(banner(page)).toContainText('This download is not available yet.');
  await expect(banner(page).getByRole('button', { name: 'Install now' })).toHaveCount(0);
  await banner(page).getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('tab', { name: 'Models', selected: true })).toBeVisible();
});

test('Settings > Models: list, install, status chip in the status bar, details', async ({
  page,
}) => {
  await start(page, { hub: { stepMs: 200 } });
  await openTab(page, 'Models');
  const row = page.getByTestId('model-upscale-x2');
  await expect(page.getByTestId('model-bgremoval-fast')).toContainText('Included');
  await expect(row).toContainText('Image Upscaler');
  await expect(page.getByText(/Installed models use about 90 MB on disk/)).toBeVisible();
  await expect(page.getByText(/Offline catalog \(bundled\)/)).toBeVisible();

  await row.getByRole('button', { name: 'Install Upscaler x2' }).click();
  await expect(page.getByTestId('status-upscale-x2')).toContainText(/Downloading \d+%/);
  // The chip lives in the status bar behind the dialog; close the dialog to see it.
  await page.keyboard.press('Escape');
  const chip = page.getByRole('button', { name: /Downloading Upscaler x2/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('tab', { name: 'Models', selected: true })).toBeVisible();
  await expect(page.getByTestId('status-upscale-x2')).toContainText('Installed', {
    timeout: 10000,
  });
  await expect(page.getByText(/Installed models use about 155 MB on disk/)).toBeVisible();

  await row.getByRole('button', { name: /Details/ }).click();
  await expect(row).toContainText('Commercial use allowed');
  await expect(row).toContainText('Test attribution');
});

test('Install recommended queues the recommended models one after another', async ({ page }) => {
  await start(page, { hub: { stepMs: 20 } });
  await openTab(page, 'Models');
  await page.getByRole('button', { name: 'Install recommended' }).click();
  for (const id of ['text-detector', 'inpaint-lama', 'upscale-x2']) {
    await expect(page.getByTestId(`status-${id}`)).toContainText('Installed', { timeout: 15000 });
  }
  await expect(page.getByTestId('status-bgremoval-quality')).toContainText('Not installed');
  await page.getByRole('button', { name: 'Install recommended' }).click();
  await expect(page.getByText('No downloads are available yet.')).toBeVisible();
});

test('Check for updates reports an unreachable catalog without breaking anything', async ({
  page,
}) => {
  await start(page, { hub: { offline: true } });
  await openTab(page, 'Models');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(
    page.getByText(/offline or the catalog server is unreachable/).first(),
  ).toBeVisible();
  await expect(page.getByTestId('model-upscale-x2')).toBeVisible();
});

test('Open models folder asks the backend', async ({ page }) => {
  await start(page);
  await openTab(page, 'Models');
  await page.getByRole('button', { name: 'Open models folder' }).click();
  await expect.poll(async () => await calls(page)).toContain('model_open_folder');
});

test.describe('first run', () => {
  test('offers the recommended models; Install recommended starts downloading', async ({
    page,
  }) => {
    await start(page, { onboarding: true, hub: { stepMs: 300 } });
    const dialog = page.getByRole('dialog', { name: 'Add the recommended models?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('about 325 MB');
    await dialog.getByRole('button', { name: /Install recommended/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: /Downloading Text Detector/ })).toBeVisible();
    expect(await calls(page)).toContain('model_install_recommended');
  });

  test('Skip for now downloads nothing and does not come back', async ({ page }) => {
    await start(page, { onboarding: true });
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const c = await calls(page);
    expect(c).not.toContain('model_install_recommended');
    // The answer was saved.
    expect(c).toContain('update_settings');
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add the recommended models?' })).toHaveCount(0);
  });
});

test.describe('import, remove and advanced settings', () => {
  test('import a matching file: installed and verified, then remove and reinstall', async ({
    page,
  }) => {
    await start(page, { hub: { stepMs: 30 } });
    await openTab(page, 'Models');
    const row = page.getByTestId('model-upscale-x2');
    // The mock's file dialog returns /downloads/model.onnx (unverified); make it a verified one.
    await page.evaluate(() => {
      (window as unknown as { __mock: { importPath?: string } }).__mock.importPath =
        '/downloads/official-model.onnx';
    });
    await row.getByRole('button', { name: 'Import file Upscaler x2' }).click();
    await expect(page.getByTestId('status-upscale-x2')).toContainText('Installed');
    await expect(page.getByTestId('unverified-upscale-x2')).toHaveCount(0);
    expect(await calls(page)).toContain('import:/downloads/official-model.onnx:strict');

    await row.getByRole('button', { name: 'Remove Upscaler x2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove Upscaler x2?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByTestId('status-upscale-x2')).toContainText('Not installed');
    expect(await calls(page)).toContain('remove:upscale-x2');

    await row.getByRole('button', { name: 'Install Upscaler x2' }).click();
    await expect(page.getByTestId('status-upscale-x2')).toContainText('Installed', {
      timeout: 10000,
    });
  });

  test('an unverified file needs an explicit "I understand" and stays marked', async ({ page }) => {
    await start(page);
    await openTab(page, 'Models');
    const row = page.getByTestId('model-upscale-x2');
    await row.getByRole('button', { name: 'Import file Upscaler x2' }).click();
    const warning = page.getByRole('dialog', { name: 'This file could not be verified' });
    await expect(warning).toBeVisible();
    await warning.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('status-upscale-x2')).toContainText('Not installed');
    expect((await calls(page)).filter((c) => c.startsWith('import:'))).toEqual([
      'import:/downloads/model.onnx:strict',
    ]);

    await row.getByRole('button', { name: 'Import file Upscaler x2' }).click();
    await page
      .getByRole('dialog', { name: 'This file could not be verified' })
      .getByRole('button', { name: 'I understand this file is unverified' })
      .click();
    await expect(page.getByTestId('status-upscale-x2')).toContainText('Installed');
    await expect(page.getByTestId('unverified-upscale-x2')).toContainText('Unverified file');
    expect((await calls(page)).filter((c) => c.startsWith('import:')).at(-1)).toBe(
      'import:/downloads/model.onnx:allow',
    );
  });

  test('the bundled model has no Remove button', async ({ page }) => {
    await start(page);
    await openTab(page, 'Models');
    await expect(page.getByTestId('model-bgremoval-fast')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Remove Background Remover \(Fast\)/ }),
    ).toHaveCount(0);
  });

  test('Advanced: validation, save and reset', async ({ page }) => {
    await start(page);
    await openTab(page, 'Models');
    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Catalog URL').fill('http://nope.example/c.json');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Enter an https:// address.')).toBeVisible();

    await page.getByLabel('Catalog URL').fill('https://mirror.example/catalog.v1.json');
    await page.getByLabel('Extra download host').fill('files.example');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Download settings saved.')).toBeVisible();
    const saved = await page.evaluate(
      () =>
        (window as unknown as { __mock: { settings: Record<string, unknown> } }).__mock.settings,
    );
    expect(saved.modelsCatalogUrl).toBe('https://mirror.example/catalog.v1.json');
    expect(saved.modelsExtraHost).toBe('files.example');

    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.getByLabel('Catalog URL')).toHaveValue('');
  });

  test('an offline failure offers Import a file in the banner', async ({ page }) => {
    await start(page, { hub: { stepMs: 20, failFirst: { 'bgremoval-quality': 'Network' } } });
    await openTab(page, 'Background removal');
    await banner(page).getByRole('button', { name: 'Install now' }).click();
    await expect(banner(page)).toContainText('import a model file');
    await banner(page).getByRole('button', { name: 'Import a file' }).click();
    await expect(page.getByRole('tab', { name: 'Models', selected: true })).toBeVisible();
  });
});

test('the banner is fully keyboard operable and focus follows its buttons', async ({ page }) => {
  await start(page, { hub: { stepMs: 200 } });
  await openTab(page, 'Background removal');
  await banner(page).getByRole('button', { name: 'Install now' }).focus();
  await page.keyboard.press('Enter');
  // The Install button is replaced by Pause; focus must not fall back to the page.
  await expect(banner(page).getByRole('button', { name: 'Pause' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(banner(page).getByRole('button', { name: 'Pause' })).toBeFocused();
});
