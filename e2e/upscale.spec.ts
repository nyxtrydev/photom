import type { Page } from '@playwright/test';
import { expect, test } from './base';
import type { useEditorStore } from '../src/stores/editorStore';
import { installTauriMock, type MockOptions } from './tauriMock';

type Photom = { __photom: { editor: typeof useEditorStore } };
type Mock = {
  upscale: {
    pending: Record<string, unknown>;
    kept: Record<string, { width: number; height: number; scale: number | null }>;
    runs: { id: string; params: Record<string, unknown> }[];
  };
  files: Record<string, { payload: { images: { state: Record<string, unknown> }[] } }>;
  history: { kind: string; name: string }[];
};

async function start(page: Page, options: MockOptions = {}) {
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
}

async function openEditor(page: Page) {
  await page.getByRole('button', { name: 'Open Images' }).click();
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(150);
}

/** Open an image and go to the Upscale tab. */
async function prepare(page: Page) {
  await openEditor(page);
  await page.getByRole('tab', { name: 'Upscale' }).click();
}

const estimate = (page: Page) => page.getByTestId('upscale-estimate');
const state = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    return st.states[st.activeId!]!;
  });
const mock = (page: Page) => page.evaluate(() => (window as unknown as { __mock: Mock }).__mock);
const upscaleButton = (page: Page) => page.getByRole('button', { name: /^Upscale( anyway)?$/ });

test('the Home sidebar entry opens the editor on the Upscale tab', async ({ page }) => {
  await start(page);
  // No image yet: the tab explains what to do.
  await page.getByRole('button', { name: 'Image Upscaler' }).click();
  await expect(page.getByRole('tab', { name: 'Upscale' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByText('Open an image to upscale it.')).toBeVisible();
});

test('from Home with an image open, the entry lands on the Upscale tab with the controls', async ({
  page,
}) => {
  await start(page);
  await openEditor(page);
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await page
    .getByRole('navigation', { name: 'Menu' })
    .getByRole('button', { name: 'File' })
    .click();
  await page.getByRole('menuitem', { name: /Home/ }).click();
  await page.getByRole('button', { name: 'Image Upscaler' }).click();
  await expect(page.getByRole('tab', { name: 'Upscale' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('upscale-estimate')).toContainText('Input 1200 x 800');
});

test('the estimate follows the scale and the custom target, and bad targets are explained', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await expect(estimate(page)).toContainText('Input 1200 x 800  →  Output 2400 x 1600 (3.8 MP)');
  await page.getByRole('radio', { name: '4x' }).click();
  await expect(estimate(page)).toContainText('Output 4800 x 3200 (15.4 MP)');
  await expect(estimate(page)).toContainText(/About \d+ s|under a second/);
  await expect(estimate(page)).toContainText(/Memory about/);

  await page.getByRole('radio', { name: 'Custom target size' }).click();
  const w = page.getByRole('textbox', { name: 'Width' });
  await w.fill('3000');
  await w.press('Enter');
  // The proportions are kept: 3000 x 2000.
  await expect(page.getByRole('textbox', { name: 'Height' })).toHaveValue('2000');
  await expect(estimate(page)).toContainText('Output 3000 x 2000 (6.0 MP)');

  await page.getByRole('button', { name: 'Keep the proportions' }).click();
  const h = page.getByRole('textbox', { name: 'Height' });
  await w.fill('1000');
  await w.press('Enter');
  await h.fill('500');
  await h.press('Enter');
  await expect(estimate(page)).toContainText('must be larger than the image');
  await expect(upscaleButton(page)).toBeDisabled();
});

test('AI needs its model: choosing it shows the install banner and holds Upscale back', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await expect(page.getByRole('radio', { name: /Standard \(no AI\)/ })).toBeChecked();
  await expect(page.getByTestId('upscale-panel').getByText(/Upscaler/)).toHaveCount(0);
  await page.getByRole('radio', { name: /AI \(Real-ESRGAN\)/ }).click();
  await expect(
    page
      .getByTestId('upscale-panel')
      .getByText(/Upscaler/)
      .first(),
  ).toBeVisible();
  await expect(upscaleButton(page)).toBeDisabled();
});

test('upscaling, reviewing and keeping: Before/After, the detail view, and the kept version', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await page.getByRole('radio', { name: '4x' }).click();
  await expect(estimate(page)).toContainText('Output 4800 x 3200');
  await upscaleButton(page).click();

  await expect(page.getByTestId('upscale-review')).toBeVisible();
  await expect(page.getByText('Review the result')).toBeVisible();
  expect((await mock(page)).upscale.runs[0]!.params).toMatchObject({
    scale: 4,
    engine: 'standard',
  });

  // Before / After divider: keyboard and pointer.
  const handle = page.getByRole('slider', { name: 'Before and after' });
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await handle.focus();
  await handle.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '52');

  // The detail view follows the pointer and shows the 100% pixels from the backend.
  const review = page.getByTestId('upscale-review');
  const box = (await review.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20);
  await page.waitForTimeout(250);
  const loupe = await page.getByTestId('upscale-loupe').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    return [
      Array.from(ctx.getImageData(10, 10, 1, 1).data),
      Array.from(ctx.getImageData(200, 10, 1, 1).data),
    ];
  });
  expect(loupe[0]![0]).toBeGreaterThan(150); // the "original" half (red in the mock)
  expect(loupe[1]![1]).toBeGreaterThan(120); // the "upscaled" half (green)

  await review.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByTestId('upscale-review')).toHaveCount(0);
  await expect(page.getByText('Upscaled version kept')).toBeVisible();
  await expect(page.getByText('4800 x 3200 · 4x, Standard')).toBeVisible();
  expect((await state(page)).upscale).toMatchObject({ width: 4800, height: 3200, scale: 4 });
  expect((await mock(page)).history[0]).toMatchObject({ kind: 'upscale' });
  // The rest of the editor knows the picture is now the upscaled one.
  await expect(page.getByText('4800 × 3200 (upscaled)')).toBeVisible();
  await page.getByRole('tab', { name: 'Background' }).click();
  await expect(page.getByTestId('export-upscaled-note')).toContainText('4800 x 3200');
});

test('discarding a result goes back to the picture; a kept version survives a rejected re-run', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await upscaleButton(page).click();
  await expect(page.getByTestId('upscale-review')).toBeVisible();
  await page.getByTestId('upscale-review').getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('upscale-review')).toHaveCount(0);
  expect((await state(page)).upscale).toBeNull();
  await expect(page.getByText('Upscaled version kept')).toHaveCount(0);

  // Keep a 2x, run 4x, reject it: the 2x stays.
  await upscaleButton(page).click();
  await page.getByTestId('upscale-review').getByRole('button', { name: 'Keep' }).click();
  await page.getByRole('radio', { name: '4x' }).click();
  await upscaleButton(page).click();
  await page.getByTestId('upscale-review').getByRole('button', { name: 'Discard' }).click();
  expect((await state(page)).upscale).toMatchObject({ scale: 2, width: 2400 });

  // Back to the original removes it.
  await page.getByRole('button', { name: 'Back to the original' }).click();
  expect((await state(page)).upscale).toBeNull();
  expect(Object.keys((await mock(page)).upscale.kept)).toHaveLength(0);
});

test('cancel stops the wait and the late result is dropped', async ({ page }) => {
  await start(page, { tickMs: 300 });
  await prepare(page);
  await upscaleButton(page).click();
  const progress = page.getByRole('status', { name: 'Upscaling progress' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Upscaling...' }).first()).toBeVisible();
  await progress.getByRole('button', { name: 'Cancel' }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByText('Upscaling was cancelled.')).toBeVisible();
  await page.waitForTimeout(1200); // the backend item finishes on its own
  await expect(page.getByTestId('upscale-review')).toHaveCount(0);
  expect(Object.keys((await mock(page)).upscale.pending)).toHaveLength(0);
});

test('a failure is explained and Try again works', async ({ page }) => {
  await start(page, { failIds: ['img1'] });
  await prepare(page);
  await upscaleButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Upscaling failed' })).toContainText(
    'The image could not be decoded.',
  );
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

test('big inputs and results: a notice, "Upscale anyway", and a blocking size limit', async ({
  page,
}) => {
  await start(page, { source: [4000, 3000], work: [600, 400] });
  await prepare(page);
  await expect(
    page.getByText('This image is already high resolution. Upscale anyway?'),
  ).toBeVisible();
  await expect(upscaleButton(page)).toHaveText('Upscale anyway');
  await expect(upscaleButton(page)).toBeEnabled(); // 2x of 12 MP is 48 MP
  await page.getByRole('radio', { name: '4x' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'limit is 100 MP' })).toBeVisible();
  await expect(upscaleButton(page)).toBeDisabled();
});

test('the kept upscale is saved with the project, marks it changed, and comes back on open', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await page.keyboard.press('Control+s');
  const title = page.locator('header').getByText(/\.photom/);
  await expect(title).toHaveText('test.photom');
  await upscaleButton(page).click();
  await page.getByTestId('upscale-review').getByRole('button', { name: 'Keep' }).click();
  await expect(title).toHaveText('test.photom *');
  await page.keyboard.press('Control+s');
  await expect(title).toHaveText('test.photom');

  const saved = (await mock(page)).files['/docs/test.photom']!.payload.images[0]!.state.upscale;
  expect(saved).toEqual({ scale: 2, width: 2400, height: 1600, engine: 'standard' });

  await page.keyboard.press('Control+n');
  await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  expect((await state(page)).upscale).toMatchObject({ width: 2400, height: 1600, scale: 2 });
  await expect(title).toHaveText('test.photom'); // opening is not an edit
});

async function addImages(page: Page, extra: number) {
  for (let i = 2; i <= extra + 1; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await expect(page.getByRole('button', { name: `photo${i}.jpg` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.waitForTimeout(200);
}

test('Upscale all images: progress, a failed image does not stop the rest, retry, every result kept', async ({
  page,
}) => {
  await start(page, { tickMs: 80, failIds: ['img2'] } as MockOptions);
  await prepare(page);
  await expect(page.getByRole('button', { name: /^Upscale all/ })).toHaveCount(0); // one image
  await addImages(page, 2);
  const all = page.getByRole('button', { name: 'Upscale all 3 images' });
  await expect(all).toBeEnabled();
  await all.click();

  const d = page.getByRole('dialog', { name: 'Upscaling images' });
  await expect(d).toBeVisible();
  await expect(d.getByRole('status')).toHaveText('2 finished, 1 failed.', { timeout: 8000 });
  const rows = d.getByRole('list').getByRole('listitem');
  await expect(rows.nth(0)).toContainText('Done');
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(2)).toContainText('Done');

  await page.evaluate(
    () => ((window as unknown as { __mock: { failIds: string[] } }).__mock.failIds = []),
  );
  await d.getByRole('button', { name: 'Retry failed' }).click();
  await expect(d.getByRole('status')).toHaveText('All 1 images finished.', { timeout: 8000 });
  const m = await mock(page);
  expect(Object.keys(m.upscale.kept).sort()).toEqual(['img1', 'img2', 'img3']);
  expect(m.upscale.kept['img1']).toMatchObject({ scale: 2 });
  await d
    .getByRole('button', { name: /Close|Done/ })
    .first()
    .click();
  await expect(page.getByText('Upscaled version kept')).toBeVisible();
});

test('Upscale all needs a scale (not a custom target size)', async ({ page }) => {
  await start(page);
  await prepare(page);
  await addImages(page, 1);
  await page.getByRole('radio', { name: 'Custom target size' }).click();
  await expect(page.getByRole('button', { name: 'Upscale all 2 images' })).toBeDisabled();
  await expect(page.getByText(/a target size is for one image/)).toBeVisible();
});

test('Settings has a separate limit for the largest upscaled result', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(
    page
      .getByRole('spinbutton', { name: 'Largest upscaled result (megapixels)' })
      .or(page.getByRole('textbox', { name: 'Largest upscaled result (megapixels)' })),
  ).toBeVisible();
});
