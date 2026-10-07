import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock, type MockOptions } from './tauriMock';

async function start(page: Page, options: MockOptions = {}) {
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
}
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

test.describe('empty states', () => {
  test('Home, History, Batch Process, quick flow and the editor all explain what to do', async ({
    page,
  }) => {
    await start(page);
    await expect(page.getByText(/No recent projects yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear' })).toBeDisabled();

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByText(/Nothing here yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Batch Process' }).click();
    await expect(page.getByText(/No images yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Remove Background', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose an image' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Image' }).click();
    await expect(page.getByText('No images open')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Images' })).toBeVisible(); // empty filmstrip
  });
});

test.describe('quick flow', () => {
  test('choose an image: the cut-out runs automatically and export is one click away', async ({
    page,
  }) => {
    await start(page);
    await page.getByRole('button', { name: 'Remove Background' }).click();
    await page.getByRole('button', { name: 'Choose an image' }).click();
    await expect(page.getByText(/Done\. Drag the handle/)).toBeVisible({ timeout: 5000 });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __mock: { calls: string[] } }).__mock.calls.filter(
            (c) => c === 'remove_background',
          ).length,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: 'Export PNG' }).click();
    await expect(page.getByRole('dialog').getByText('Export PNG')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fine-tune in editor' }).click();
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  });
});

test.describe('error states', () => {
  test('model missing: a clear message with a way to fix it', async ({ page }) => {
    await start(page, {
      errors: {
        remove_background: {
          code: 'ModelMissing',
          message: 'isnet-general-use-fp16.onnx not found',
        },
      },
    });
    await page.getByRole('button', { name: 'Open Images' }).click();
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove BG' }).click();

    const toast = toasts(page).getByRole('alert');
    await expect(toast.getByText('The background removal model is missing.')).toBeVisible();
    await toast.getByText('Show details').click();
    await expect(toast.getByText(/Photom works offline/)).toBeVisible();
    await toast.getByRole('button', { name: 'Open model settings' }).click();
    await expect(
      page.getByRole('tab', { name: 'Background removal', selected: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import model file...' })).toBeVisible();
  });

  test('out of memory: suggests a smaller image or a higher limit', async ({ page }) => {
    await start(page, {
      errors: {
        remove_background: {
          code: 'OutOfMemory',
          message: 'image is 120 MP, above the 100 MP limit',
        },
      },
    });
    await page.getByRole('button', { name: 'Open Images' }).click();
    await page.getByRole('button', { name: 'Remove BG' }).click();
    const toast = toasts(page).getByRole('alert');
    await expect(toast.getByText('Not enough memory to process this image.')).toBeVisible();
    await toast.getByText('Show details').click();
    await expect(toast.getByText(/smaller image/)).toBeVisible();
    await toast.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.getByRole('tab', { name: 'General', selected: true })).toBeVisible();
  });

  test('unsupported file: rejected with the reason, nothing else breaks', async ({ page }) => {
    await start(page, { rejectImport: true });
    await page.getByRole('button', { name: 'Open Images' }).click();
    const toast = toasts(page).getByRole('alert');
    await expect(toast.getByText('Could not import notes.txt')).toBeVisible();
    await toast.getByText('Show details').click();
    await expect(toast.getByText(/Unsupported file type/)).toBeVisible();
    await expect(page.getByText('Drag & drop images here')).toBeVisible(); // still on Home
  });

  test('corrupt project: explains it, reassures about the originals, changes nothing', async ({
    page,
  }) => {
    await start(page, {
      errors: { open_project: { code: 'ProjectCorrupt', message: 'truncated archive' } },
    });
    await page.getByRole('button', { name: 'Open project...' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('This project could not be opened')).toBeVisible();
    await expect(dialog.getByText(/original images are not affected/)).toBeVisible();
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Drag & drop images here')).toBeVisible();
  });

  test('toasts auto-dismiss for good news but errors stay', async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __photom: { ui: { getState: () => { notify: (k: string, m: string) => void } } };
        }
      ).__photom.ui;
      ui.getState().notify('success', 'Saved dog.photom');
      ui.getState().notify('error', 'Export failed.');
    });
    await expect(toasts(page).getByText('Saved dog.photom')).toBeVisible();
    await expect(toasts(page).getByText('Saved dog.photom')).toBeHidden({ timeout: 9000 });
    await expect(toasts(page).getByText('Export failed.')).toBeVisible();
  });
});

test.describe('loading states', () => {
  test('the canvas shows a processing overlay while the cut-out runs', async ({ page }) => {
    await start(page, { tickMs: 50 });
    await page.getByRole('button', { name: 'Open Images' }).click();
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __photom: {
            project: { getState: () => { setProcessing: (id: string, on: boolean) => void } };
          };
        }
      ).__photom.project
        .getState()
        .setProcessing('img1', true);
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Processing...' }).first(),
    ).toBeVisible();
  });
});
