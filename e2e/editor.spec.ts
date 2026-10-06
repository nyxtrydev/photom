import type { Page } from '@playwright/test';
import { expect, test } from './base';
import type { useEditorStore } from '../src/stores/editorStore';
import { installTauriMock } from './tauriMock';

/** Dev-only store handle exposed by src/main.tsx. */
type Photom = { __photom: { editor: typeof useEditorStore } };

type Rgb = [number, number, number, number];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
});

/** Open an image from Home and wait until the editor canvas has rendered it. */
async function openEditor(page: Page) {
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(150); // session load + first frame
}

const viewState = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    const s = st.states[st.activeId];
    return { vp: s.viewport, split: s.split, source: s.source, state: s };
  });

/** Screen position (CSS px, canvas-local) of a source-image point. */
async function screenOf(page: Page, x: number, y: number) {
  const { vp } = await viewState(page);
  return { x: vp.panX + x * vp.zoom, y: vp.panY + y * vp.zoom };
}

async function pixel(page: Page, x: number, y: number): Promise<Rgb> {
  return page.evaluate(
    ([px, py]) => {
      const c = document.querySelector('canvas')!;
      const ctx = c.getContext('2d')!;
      return Array.from(ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data) as Rgb;
    },
    [x, y],
  );
}

const near = (a: Rgb, b: [number, number, number], tol = 12) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const BLUE: [number, number, number] = [0x20, 0x60, 0xc0];
const ORANGE: [number, number, number] = [0xe0, 0x70, 0x20];

// The canvas host is offset from the viewport; the canvas element fills it.
async function canvasOrigin(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
}

test('import -> editor shows Before/After; Remove BG cuts out the subject', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByText('Press Remove BG to cut out the subject.')).toBeVisible();

  // Move the divider fully left so every sample is in the After region.
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setSplit('img1', 0),
  );
  await page.waitForTimeout(50);
  const bgPoint = await screenOf(page, 100, 100);
  expect(near(await pixel(page, bgPoint.x, bgPoint.y), BLUE)).toBe(true); // no mask yet: original shown

  await page.getByRole('button', { name: 'Remove BG' }).click();
  await expect(page.getByText('Press Remove BG to cut out the subject.')).toBeHidden();
  await page.waitForTimeout(250);

  expect(near(await pixel(page, bgPoint.x, bgPoint.y), BLUE)).toBe(false); // now transparent (checker)
  const disc = await screenOf(page, 600, 400);
  expect(near(await pixel(page, disc.x, disc.y), ORANGE)).toBe(true); // subject kept

  // Before side still shows the untouched original.
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setSplit('img1', 1),
  );
  await page.waitForTimeout(50);
  expect(near(await pixel(page, bgPoint.x, bgPoint.y), BLUE)).toBe(true);
});

test('Before/After handle follows the image at every zoom level', async ({ page }) => {
  await openEditor(page);
  const origin = await canvasOrigin(page);

  // Pan so image x=600 sits at screen x=400, then the 50% handle must sit at 400 for every zoom;
  // a different split must land at the matching image position.
  for (const zoom of [0.5, 1, 2]) {
    await page.evaluate((z) => {
      const st = (window as unknown as Photom).__photom.editor.getState();
      st.setViewport(st.activeId, { zoom: z, panX: 400 - 600 * z, panY: 60 - 80 * z });
      st.setSplit(st.activeId, 0.5);
    }, zoom);
    await page.waitForTimeout(60);
    const mid = await page.getByTestId('compare-handle').boundingBox();
    expect(Math.abs(mid!.x - (origin.x + 400))).toBeLessThan(3);

    await page.evaluate(() => {
      const st = (window as unknown as Photom).__photom.editor.getState();
      st.setSplit(st.activeId, 0.6);
    });
    await page.waitForTimeout(60);
    const moved = await page.getByTestId('compare-handle').boundingBox();
    expect(Math.abs(moved!.x - (origin.x + 400 + 120 * zoom))).toBeLessThan(3);
  }

  // Dragging the handle updates the split to the pointer position.
  await page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    st.setViewport(st.activeId, { zoom: 0.5, panX: 100, panY: 50 });
  });
  await page.waitForTimeout(60);
  const hb = (await page.getByTestId('compare-handle').boundingBox())!;
  const y = hb.y + hb.height / 2;
  await page.mouse.move(hb.x, y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 100 + 600 * 0.5 * 0.25 * 2, y, { steps: 5 });
  await page.mouse.up();
  const { split } = await viewState(page);
  expect(split).toBeCloseTo(0.25, 1);
});

test('brush: Erase removes subject pixels, Keep restores, Undo/Redo replay strokes', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    st.setSplit(st.activeId, 0); // After everywhere
    st.setBrush({ size: 80, hardness: 100 });
  });
  const origin = await canvasOrigin(page);
  const c = await screenOf(page, 600, 400);
  expect(near(await pixel(page, c.x, c.y), ORANGE)).toBe(true);

  // Erase across the disc centre.
  await page.keyboard.press('e');
  await page.mouse.move(origin.x + c.x - 40, origin.y + c.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + c.x + 40, origin.y + c.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(near(await pixel(page, c.x, c.y), ORANGE)).toBe(false);
  expect((await viewState(page)).state.strokes).toHaveLength(1);

  // Undo restores the pixel; Redo erases again.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  expect(near(await pixel(page, c.x, c.y), ORANGE)).toBe(true);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  expect(near(await pixel(page, c.x, c.y), ORANGE)).toBe(false);

  // Keep paints it back.
  await page.keyboard.press('b');
  await page.mouse.move(origin.x + c.x - 40, origin.y + c.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + c.x + 40, origin.y + c.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(near(await pixel(page, c.x, c.y), ORANGE)).toBe(true);
});

test('refine is non-destructive: Edge shift grows the cut-out and Undo restores it', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setSplit('img1', 0),
  );

  // 30 source px outside the disc edge (radius 240 around (600,400)).
  const outside = await screenOf(page, 600 + 255, 400);
  expect(near(await pixel(page, outside.x, outside.y), ORANGE)).toBe(false);

  const input = page.getByRole('textbox', { name: 'Edge shift value' });
  await input.fill('20');
  await input.press('Enter');
  await page.waitForTimeout(250);
  // The grown mask now keeps those source pixels, which are the original blue background.
  expect(near(await pixel(page, outside.x, outside.y), BLUE)).toBe(true);
  expect((await viewState(page)).state.refine.edgeShift).toBe(20);

  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(250);
  expect((await viewState(page)).state.refine.edgeShift).toBe(0);
  expect(near(await pixel(page, outside.x, outside.y), BLUE)).toBe(false); // transparent again
});

test('solid background fills transparent areas of the After view', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setSplit('img1', 0),
  );
  await page.getByRole('radio', { name: 'Solid color' }).click();
  const hex = page.getByRole('textbox', { name: 'Hex color' });
  await hex.fill('#00ff00');
  await hex.press('Enter');
  await page.waitForTimeout(150);
  const bg = await screenOf(page, 100, 100);
  expect(near(await pixel(page, bg.x, bg.y), [0, 255, 0])).toBe(true);
  const subject = await screenOf(page, 600, 400);
  expect(near(await pixel(page, subject.x, subject.y), ORANGE)).toBe(true);
});

test('zoom keeps the point under the cursor fixed; Fit and 100% work', async ({ page }) => {
  await openEditor(page);
  const origin = await canvasOrigin(page);
  const before = await viewState(page);
  const cx = origin.x + 300;
  const cy = origin.y + 200;
  const imgBefore = {
    x: (300 - before.vp.panX) / before.vp.zoom,
    y: (200 - before.vp.panY) / before.vp.zoom,
  };

  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForTimeout(80);
  const after = await viewState(page);
  expect(after.vp.zoom).toBeGreaterThan(before.vp.zoom * 1.5);
  const imgAfter = {
    x: (300 - after.vp.panX) / after.vp.zoom,
    y: (200 - after.vp.panY) / after.vp.zoom,
  };
  expect(Math.abs(imgAfter.x - imgBefore.x)).toBeLessThan(1);
  expect(Math.abs(imgAfter.y - imgBefore.y)).toBeLessThan(1);

  await page.keyboard.press('Control+1');
  expect((await viewState(page)).vp.zoom).toBeCloseTo(1, 2);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  const fit = await viewState(page);
  expect(fit.vp.zoom).toBeLessThan(1);
  await expect(page.getByText(/^\d+%$/)).toBeVisible();
});

test("switching images preserves each image's state", async ({ page }) => {
  await openEditor(page);
  await page.getByRole('textbox', { name: 'Feather value' }).fill('9');
  await page.getByRole('textbox', { name: 'Feather value' }).press('Enter');
  await page.getByRole('button', { name: 'Add Images' }).click();
  await expect(page.getByRole('button', { name: 'photo2.jpg' })).toBeVisible();
  await page.getByRole('button', { name: 'photo2.jpg' }).click();
  await expect(page.getByRole('textbox', { name: 'Feather value' })).toHaveValue('2');
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await expect(page.getByRole('textbox', { name: 'Feather value' })).toHaveValue('9');
  await page.waitForTimeout(200);
  const subject = await screenOf(page, 600, 400);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setSplit('img1', 1),
  );
  await page.waitForTimeout(80);
  expect(near(await pixel(page, subject.x, subject.y), ORANGE)).toBe(true); // canvas re-rendered
});
