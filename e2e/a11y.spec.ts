import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock } from './tauriMock';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes
      .slice(0, 3)
      .map(
        (n) =>
          n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n').slice(0, 2).join(' '),
      ),
  }));
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

async function start(page: Page, theme: 'light' | 'dark', options = {}) {
  // Also proves the app honours prefers-reduced-motion, and keeps colour sampling deterministic.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    (
      window as unknown as { __photom: { settings: { setState: (s: unknown) => void } } }
    ).__photom.settings.setState({ theme: t });
  }, theme);
}

async function openEditor(page: Page, count = 1) {
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  for (let i = 2; i <= count; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await expect(page.getByRole('button', { name: `photo${i}.jpg` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.waitForTimeout(300);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${theme})`, () => {
    test('Home, Remove Background, Batch Process and History screens', async ({ page }) => {
      await start(page, theme);
      await audit(page, 'Home');
      await page.getByRole('button', { name: 'Remove Background' }).click();
      await audit(page, 'Remove Background (empty)');
      await page.getByRole('button', { name: 'Batch Process' }).click();
      await audit(page, 'Batch Process (empty)');
      await page.getByRole('button', { name: 'History' }).click();
      await audit(page, 'History (empty)');
    });

    test('Editor with an image, menus and tool states', async ({ page }) => {
      await start(page, theme);
      await openEditor(page, 2);
      await page.getByRole('button', { name: 'Remove BG' }).click();
      await page.waitForTimeout(400);
      await audit(page, 'Editor');
      await page.getByRole('radio', { name: 'Solid color' }).click();
      await audit(page, 'Editor with solid background');
      await page.getByRole('button', { name: 'View' }).click();
      await audit(page, 'View menu open');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'More export options' }).click();
      await audit(page, 'Export dropdown open');
      await page.keyboard.press('Escape');
    });

    test('Dialogs: export, batch progress, settings tabs, confirm, recovery', async ({ page }) => {
      await start(page, theme, { tickMs: 400 });
      await openEditor(page, 3);
      await page.keyboard.press('Control+e');
      await page.getByRole('textbox', { name: 'Folder' }).fill('/exports');
      await audit(page, 'Export dialog');
      await page.getByRole('radio', { name: /All images/ }).click();
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByRole('progressbar')).toBeVisible();
      await audit(page, 'Batch progress dialog (running)');
      await expect(page.getByRole('status').filter({ hasText: 'finished' })).toBeVisible({
        timeout: 10000,
      });
      await audit(page, 'Batch progress dialog (finished)');
      await page.getByRole('button', { name: 'Close' }).click();

      await page.getByRole('button', { name: 'Settings' }).first().click();
      for (const tab of [
        'General',
        'Background removal',
        'Models',
        'Export',
        'Shortcuts',
        'About',
      ]) {
        await page.getByRole('tab', { name: tab }).click();
        await audit(page, `Settings: ${tab}`);
      }
      await page.keyboard.press('Escape');

      await page.keyboard.press('Control+n'); // dirty -> confirmation
      await expect(page.getByText('Unsaved changes')).toBeVisible();
      await audit(page, 'Confirm dialog');
    });

    test('Shadow tab', async ({ page }) => {
      await start(page, theme);
      await openEditor(page);
      await page.getByRole('tab', { name: 'Shadow' }).click();
      await audit(page, 'Shadow tab (needs a cut-out)');
      await page.getByRole('button', { name: 'Remove BG' }).first().click();
      await page.waitForTimeout(300);
      await page.getByRole('checkbox', { name: 'Enable' }).click();
      await page.getByRole('button', { name: /Add a shadow layer/ }).click();
      await page.getByRole('menuitem', { name: /Cast shadow/ }).click();
      await page.waitForTimeout(250);
      await audit(page, 'Shadow tab (two layers)');
      await page.getByRole('checkbox', { name: 'Enable' }).click();
      await audit(page, 'Shadow tab (disabled)');
    });

    test('Upscale tab: controls, estimate, result review and kept version', async ({ page }) => {
      await start(page, theme);
      await openEditor(page);
      await page.getByRole('tab', { name: 'Upscale' }).click();
      await expect(page.getByTestId('upscale-estimate')).toContainText('Output');
      await audit(page, 'Upscale tab');
      await page.getByRole('radio', { name: 'Custom target size' }).click();
      await audit(page, 'Upscale tab (custom target)');
      await page.getByRole('button', { name: /^Upscale$/ }).click();
      await expect(page.getByTestId('upscale-review')).toBeVisible();
      await page.waitForTimeout(300);
      await audit(page, 'Upscale result review');
      await page.getByTestId('upscale-review').getByRole('button', { name: 'Keep' }).click();
      await expect(page.getByText('Upscaled version kept')).toBeVisible();
      await audit(page, 'Upscale tab (kept version)');
    });

    test('Upscale tab with several images, AI choice and the batch dialog', async ({ page }) => {
      await start(page, theme);
      await openEditor(page, 2);
      await page.getByRole('tab', { name: 'Upscale' }).click();
      await expect(page.getByRole('button', { name: 'Upscale all 2 images' })).toBeVisible();
      await expect(page.getByTestId('upscale-estimate')).toContainText('Output');
      await audit(page, 'Upscale tab (several images)');
      await page.getByRole('radio', { name: /AI \(Real-ESRGAN\)/ }).click();
      await audit(page, 'Upscale tab (AI chosen, model needed)');
      await page.getByRole('radio', { name: /Standard \(no AI\)/ }).click();
      await expect(page.getByTestId('upscale-estimate')).toContainText('Output');
      await page.getByRole('checkbox', { name: 'Reduce artefacts' }).click();
      await page.getByRole('button', { name: 'Upscale all 2 images' }).click();
      await expect(page.getByRole('dialog', { name: 'Upscaling images' })).toBeVisible();
      await page.waitForTimeout(400);
      await audit(page, 'Batch upscale dialog');
    });

    test('Shadow tab: presets, reflection, guides, apply to all, export options', async ({
      page,
    }) => {
      await start(page, theme);
      await openEditor(page, 2);
      await page.getByRole('tab', { name: 'Shadow' }).click();
      await page.getByRole('button', { name: 'Remove BG' }).first().click();
      await page.waitForTimeout(300);
      await page.getByRole('checkbox', { name: 'Enable' }).click();
      await page
        .getByRole('group', { name: 'Preset' })
        .getByRole('button', { name: 'Soft studio' })
        .click();
      await page.waitForTimeout(300);
      // The ground line and light handles sit on the canvas.
      await expect(page.getByRole('slider', { name: 'Light direction' })).toBeVisible();
      await audit(page, 'Shadow tab (Soft studio preset, handles visible)');
      await page.getByRole('button', { name: 'Save as preset' }).click();
      await audit(page, 'Shadow tab (naming a preset)');
      await page.keyboard.press('Escape');
      await page.getByRole('checkbox', { name: /Shadow only/ }).click();
      await page.waitForTimeout(200);
      await audit(page, 'Shadow only view');
      await page.getByRole('checkbox', { name: /Shadow only/ }).click();
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Include shadow' })).toBeVisible();
      await audit(page, 'Export dialog with shadow options');
    });

    test('Model hub: first-run offer, Models page and install banner', async ({ page }) => {
      await start(page, theme, { onboarding: true, hub: { stepMs: 400 } });
      await expect(page.getByRole('dialog', { name: 'Add the recommended models?' })).toBeVisible();
      await audit(page, 'First-run model offer');
      await page.getByRole('button', { name: /Install recommended/ }).click();

      await page.getByRole('button', { name: 'Settings' }).first().click();
      await page.getByRole('tab', { name: 'Models' }).click();
      await expect(page.getByTestId('status-text-detector')).toContainText(/Downloading|Waiting/);
      await audit(page, 'Models page (downloading)');
      await page
        .getByRole('button', { name: /Details/ })
        .first()
        .click();
      await audit(page, 'Models page (details open)');

      await page.getByRole('tab', { name: 'Models' }).click();
      await page.getByRole('button', { name: 'Advanced' }).click();
      await audit(page, 'Models page (advanced open)');

      await page.getByRole('tab', { name: 'Background removal' }).click();
      await expect(page.getByTestId('model-install-banner')).toBeVisible();
      await audit(page, 'Install banner');
      await page
        .getByTestId('model-install-banner')
        .getByRole('button', { name: 'Install now' })
        .click();
      await expect(
        page.getByTestId('model-install-banner').getByRole('button', { name: 'Pause' }),
      ).toBeVisible();
      await audit(page, 'Install banner (downloading)');
    });

    test('Recovery dialog and toasts', async ({ page }) => {
      await start(page, theme, {
        recovery: [
          {
            entry: {
              id: 'p',
              name: 'Old work',
              savedAt: new Date().toISOString(),
              originalPath: null,
              imageCount: 2,
            },
            payload: { projectId: 'p', name: 'Old work', activeId: null, images: [] },
            hasMask: false,
          },
        ],
      });
      await expect(page.getByText('Recover unsaved work?')).toBeVisible();
      await audit(page, 'Recovery dialog');
      await page.getByRole('button', { name: 'Discard' }).click();
      await page.getByRole('button', { name: 'Keep it' }).click();
      await page.evaluate(() => {
        const ui = (
          window as unknown as {
            __photom: {
              ui: { getState: () => { notify: (k: string, m: string, d?: string) => void } };
            };
          }
        ).__photom.ui;
        ui.getState().notify('error', 'A file could not be read or written.', 'os error 2');
        ui.getState().notify('success', 'Saved dog.photom');
        ui.getState().notify('warning', 'Could not import notes.txt', 'Unsupported file type.');
      });
      await audit(page, 'Recovery dialog + toasts');
    });
  });
}
