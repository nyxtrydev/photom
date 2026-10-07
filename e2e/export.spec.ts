import type { Page } from '@playwright/test';
import { expect, test } from './base';
import type { useEditorStore } from '../src/stores/editorStore';
import { installTauriMock, type MockOptions } from './tauriMock';

type Photom = { __photom: { editor: typeof useEditorStore } };
type Mock = {
  calls: string[];
  exports: {
    items: { id: string; state: unknown }[];
    options: Record<string, unknown> & { crop?: unknown };
  }[];
  clipboard: unknown[];
  failIds: string[];
  jobs: Record<string, { items: { status: string }[] }>;
};
const mock = (page: Page) => page.evaluate(() => (window as unknown as { __mock: Mock }).__mock);

async function start(page: Page, options: MockOptions = {}) {
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
}

/** Open the first image from Home, then add more through the filmstrip. */
async function openImages(page: Page, count = 1) {
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  for (let i = 2; i <= count; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await expect(page.getByRole('button', { name: `photo${i}.jpg` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.waitForTimeout(200);
}

const dialog = (page: Page) => page.getByRole('dialog');

test('single export: dialog options reach the backend, a toast offers Open folder, History records it', async ({
  page,
}) => {
  await start(page);
  await openImages(page);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const d = dialog(page);
  await expect(d.getByText('Export PNG')).toBeVisible();
  await d.getByRole('textbox', { name: 'Folder' }).fill('/exports');
  await d.getByRole('checkbox', { name: 'Crop to subject' }).click();
  const pad = d.getByRole('textbox', { name: 'Padding' });
  await pad.fill('12');
  await pad.press('Tab');
  await d.getByRole('radio', { name: 'Keep selected background' }).click();
  await d.getByRole('textbox', { name: 'Filename' }).fill('{name}_cutout.png');
  await d.getByRole('button', { name: 'Export', exact: true }).click();

  await expect(dialog(page)).toBeHidden();
  const sent = (await mock(page)).exports[0]!;
  expect(sent.items.map((i) => i.id)).toEqual(['img1']);
  expect(sent.options).toMatchObject({
    background: 'keepSelected',
    crop: { enabled: true, padding: 12 },
    compression: 6,
    filenameTemplate: '{name}_cutout.png',
    folder: '/exports',
    size: { mode: 'original' },
  });
  expect(sent.options.scope).toBeUndefined();

  // A single image: a toast, not the batch dialog.
  const toast = page.getByRole('region', { name: 'Notifications' });
  await expect(toast.getByText('Exported photo1-photom.png')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(toast.getByRole('button', { name: 'Copy path' })).toBeVisible();
  await toast.getByRole('button', { name: 'Open folder' }).click();
  expect((await mock(page)).calls).toContain('reveal_path:/exports/photo1-photom.png');
  await expect(toast.getByText('Exported photo1-photom.png')).toBeHidden(); // an action closes its toast

  // History records it.
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('list', { name: 'History' }).getByText(/^Export ·/)).toBeVisible();
  await expect(page.getByText('photo1.jpg').first()).toBeVisible();
});

test('Ctrl+E opens the export dialog and Escape closes it; the folder is required', async ({
  page,
}) => {
  await start(page);
  await openImages(page);
  await page.keyboard.press('Control+e');
  await expect(dialog(page).getByText('Export PNG')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('Choose an output folder.');
  expect((await mock(page)).exports).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('batch export: live progress, per-item status, a failed item does not stop the rest, retry', async ({
  page,
}) => {
  await start(page, { failIds: ['img2'], tickMs: 80 });
  await openImages(page, 3);
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const d = dialog(page);
  await d.getByRole('radio', { name: /All images \(3\)/ }).click();
  await d.getByRole('textbox', { name: 'Folder' }).fill('/exports');
  await d.getByRole('button', { name: 'Export', exact: true }).click();

  const progress = dialog(page).getByRole('progressbar');
  await expect(progress).toBeVisible();
  await expect(dialog(page).getByRole('status')).toHaveText('2 finished, 1 failed.', {
    timeout: 8000,
  });
  expect(await progress.getAttribute('aria-valuenow')).toBe('100');

  const rows = dialog(page).getByRole('list').getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Done');
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(1)).toContainText('Remove the background of this image');
  await expect(rows.nth(2)).toContainText('Done'); // the batch carried on past the failure

  // Retry sends only the failed image, and it takes over the dialog.
  await page.evaluate(() => ((window as unknown as { __mock: Mock }).__mock.failIds = []));
  await dialog(page).getByRole('button', { name: 'Retry failed' }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('All 1 images finished.', {
    timeout: 8000,
  });
  const m = await mock(page);
  expect(m.exports).toHaveLength(2);
  expect(m.exports[1]!.items.map((i) => i.id)).toEqual(['img2']);
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
});

test('batch export can be paused, resumed and cancelled cleanly', async ({ page }) => {
  await start(page, { tickMs: 200 });
  await openImages(page, 5);
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const d = dialog(page);
  await d.getByRole('radio', { name: /All images \(5\)/ }).click();
  await d.getByRole('textbox', { name: 'Folder' }).fill('/exports');
  await d.getByRole('button', { name: 'Export', exact: true }).click();

  const doneCount = async () => {
    const t = await dialog(page)
      .getByText(/ of 5 complete/)
      .first()
      .textContent();
    return Number(t!.split(' ')[0]);
  };
  await expect(dialog(page).getByRole('button', { name: 'Pause' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Pause' }).click();
  await expect(
    dialog(page)
      .getByText(/Paused/)
      .first(),
  ).toBeVisible();
  await page.waitForTimeout(500); // let any in-flight item settle
  const frozen = await doneCount();
  await page.waitForTimeout(900);
  expect(await doneCount()).toBe(frozen); // nothing advances while paused

  await dialog(page).getByRole('button', { name: 'Resume' }).click();
  await expect.poll(doneCount, { timeout: 5000 }).toBeGreaterThan(frozen);

  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page).getByRole('status')).toContainText('Cancelled.', { timeout: 5000 });
  const rows = dialog(page).getByRole('list').getByRole('listitem');
  expect(await rows.filter({ hasText: 'Cancelled' }).count()).toBeGreaterThan(0);
  // Nothing is left half-way: no row is still queued or processing.
  expect(await rows.filter({ hasText: /Queued|Processing/ }).count()).toBe(0);
  await expect(dialog(page).getByRole('button', { name: 'Pause' })).toHaveCount(0);
});

test('Batch Process screen: remove every background in one run, then see them ready', async ({
  page,
}) => {
  await start(page, { tickMs: 60 });
  await openImages(page, 3);
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'Batch Process' }).click();

  await expect(page.getByText('3 images · 0 with cut-out')).toBeVisible();
  await page.getByRole('button', { name: 'Remove backgrounds' }).click();
  await expect(dialog(page).getByText('Removing backgrounds')).toBeVisible();
  await expect(dialog(page).getByRole('status')).toHaveText('All 3 images finished.', {
    timeout: 8000,
  });
  await dialog(page).getByRole('button', { name: 'Close' }).click();

  await expect(page.getByText('3 images · 3 with cut-out')).toBeVisible();
  const rows = page.getByRole('list', { name: 'Images in this batch' }).getByRole('listitem');
  await expect(rows.filter({ hasText: 'Cut-out ready' })).toHaveCount(3);
  // Results are undoable edits in the editor.
  const undo = await page.evaluate(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.states['img2']!.undo.map((c) => c.type);
  });
  expect(undo).toContain('rerun');

  // Export all from here opens the dialog on "All images".
  await page.getByRole('button', { name: 'Export all...' }).click();
  await expect(dialog(page).getByRole('radio', { name: /All images \(3\)/ })).toBeChecked();
});

test('copy to clipboard renders the current image through the backend', async ({ page }) => {
  await start(page);
  await openImages(page);
  await page.keyboard.press('Control+Shift+c');
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Copied to the clipboard.'),
  ).toBeVisible();
  expect((await mock(page)).clipboard).toHaveLength(1);
});

test('presets: save a custom preset, find it in the toolbar dropdown, and it applies when chosen', async ({
  page,
}) => {
  await start(page);
  await openImages(page);
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Crop to subject' }).click();
  await d.getByRole('button', { name: 'Save as preset' }).click();
  await d.getByRole('textbox', { name: 'Preset name' }).fill('Shop crop');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(d.getByRole('combobox', { name: 'Preset' })).toHaveValue(/preset-1/);
  await d.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'More export options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Web' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Shop crop' }).click();
  await expect(dialog(page).getByRole('checkbox', { name: 'Crop to subject' })).toBeChecked();
  await expect(dialog(page).getByRole('combobox', { name: 'Preset' })).toHaveValue(/preset-1/);
});

test('the Export dialog offers Include shadow / Shadow on separate layer when a shadow is on', async ({
  page,
}) => {
  await start(page);
  await openImages(page);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  let d = dialog(page);
  await expect(d.getByRole('checkbox', { name: 'Include shadow' })).toHaveCount(0);
  await d.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('tab', { name: 'Shadow' }).click();
  await page.getByRole('checkbox', { name: 'Enable' }).click();
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  d = dialog(page);
  await expect(d.getByRole('checkbox', { name: 'Include shadow' })).toBeChecked();
  await d.getByRole('textbox', { name: 'Folder' }).fill('/exports');
  await d.getByRole('checkbox', { name: 'Shadow on separate layer' }).click();
  await d.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog(page)).toBeHidden();

  const sent = (await mock(page)).exports[0]!;
  expect(sent.options).toMatchObject({ includeShadow: true, shadowLayer: true });
  const state = sent.items[0]!.state as {
    shadow: { enabled: boolean; layers: { type: string }[] };
  };
  expect(state.shadow.enabled).toBe(true);
  expect(state.shadow.layers[0]).toMatchObject({ type: 'drop' });
});
