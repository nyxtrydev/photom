import type { Page } from '@playwright/test';
import { expect, test } from './base';
import type { useEditorStore } from '../src/stores/editorStore';
import type { useProjectStore } from '../src/stores/projectStore';
import { installTauriMock, type MockOptions } from './tauriMock';

type Photom = {
  __photom: { editor: typeof useEditorStore; project: typeof useProjectStore };
  __mock: {
    calls: string[];
    files: Record<string, { payload: { images: { state: Record<string, unknown> }[] } }>;
  };
};
type Rgb = [number, number, number, number];

// Mock image: 1200x800, orange disc (centre 600,400, radius 240) on blue. The cut-out is the disc.
const CX = 600;
const CY = 400;

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

const state = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    return st.states[st.activeId!]!;
  });

async function pixel(page: Page, srcX: number, srcY: number): Promise<Rgb> {
  const s = await state(page);
  const vp = s.viewport!;
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('canvas')!;
      return Array.from(
        c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      ) as Rgb;
    },
    [vp.panX + srcX * vp.zoom, vp.panY + srcY * vp.zoom],
  );
}

const luma = (p: Rgb) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

/** Cut out the subject, show only the After view on a white background, open the Shadow tab. */
async function prepare(page: Page) {
  await openEditor(page);
  await page.getByRole('button', { name: 'Remove BG' }).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ed = (window as unknown as Photom).__photom.editor.getState();
    ed.setCompare('after');
    ed.setBackground('img1', { kind: 'solid', color: '#ffffff' });
  });
  await page.getByRole('tab', { name: 'Shadow' }).click();
}

const enable = (page: Page) => page.getByRole('checkbox', { name: 'Enable' });
const field = (page: Page, name: string) => page.getByRole('textbox', { name: `${name} value` });

async function setField(page: Page, name: string, value: number) {
  const f = field(page, name);
  await f.fill(String(value));
  await f.press('Enter');
  await page.waitForTimeout(200); // let the preview settle
}

test('the Shadow tab asks for a cut-out first, then unlocks', async ({ page }) => {
  await start(page);
  await openEditor(page);
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await expect(page.getByText(/Remove the background first/)).toBeVisible();
  await expect(enable(page)).toBeDisabled();

  await page.getByTestId('shadow-panel').getByRole('button', { name: 'Remove BG' }).click();
  await expect(enable(page)).toBeEnabled();
  await expect(page.getByText(/Remove the background first/)).toBeHidden();
});

test('enabling draws a soft drop shadow down and to the right of the subject', async ({ page }) => {
  await start(page);
  await prepare(page);
  const plain = await pixel(page, CX + 175, CY + 175); // just outside the disc, lower right
  expect(luma(plain)).toBeGreaterThan(250); // white background

  await enable(page).click();
  await expect(page.getByTestId('shadow-layer')).toHaveCount(1);
  await page.waitForTimeout(250);

  const lowerRight = await pixel(page, CX + 175, CY + 175);
  const upperLeft = await pixel(page, CX - 175, CY - 175);
  expect(luma(lowerRight)).toBeLessThan(luma(plain) - 20); // shadow darkens it
  expect(luma(upperLeft)).toBeGreaterThan(250); // the opposite side stays clean
  // The shadow is brownish (warm black), not grey.
  expect(lowerRight[0]).toBeGreaterThan(lowerRight[2]);
  // The subject itself is untouched.
  expect((await pixel(page, CX, CY)).slice(0, 3)).toEqual([0xe0, 0x70, 0x20]);
});

test('sliders move the shadow; distance 0 puts it directly behind the subject', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Distance', 0);
  await setField(page, 'Blur', 0);
  const behind = await pixel(page, CX + 175, CY + 175);
  expect(luma(behind)).toBeGreaterThan(250); // nothing sticks out any more

  await setField(page, 'Distance', 60);
  expect(luma(await pixel(page, CX + 175, CY + 175))).toBeLessThan(200);

  await setField(page, 'Opacity', 0);
  expect(luma(await pixel(page, CX + 175, CY + 175))).toBeGreaterThan(250);
});

test('hiding the layer removes the shadow, showing it brings it back', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await page.waitForTimeout(250);
  const dark = luma(await pixel(page, CX + 175, CY + 175));
  expect(dark).toBeLessThan(230);

  await page.getByRole('button', { name: 'Hide Drop shadow' }).click();
  await page.waitForTimeout(200);
  expect(luma(await pixel(page, CX + 175, CY + 175))).toBeGreaterThan(250);
  await page.getByRole('button', { name: 'Show Drop shadow' }).click();
  await page.waitForTimeout(200);
  expect(luma(await pixel(page, CX + 175, CY + 175))).toBeLessThan(230);
});

test('a shadow that falls off the image grows the canvas so it is not clipped', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  expect((await state(page)).frame).toEqual({ x: 0, y: 0, w: 1200, h: 800 }); // fits inside

  await setField(page, 'Distance', 300);
  const grown = (await state(page)).frame;
  expect(grown.x).toBe(0);
  expect(grown.w).toBe(1200);
  // subject bottom 640 + 300*sin45 (212) + 3 sigma (48) is about 900
  expect(grown.h).toBeGreaterThan(890);
  expect(grown.h).toBeLessThan(915);

  // The view re-fits so the whole result is visible, and the margin is drawn (not page background).
  const vp = (await state(page)).viewport!;
  const box = await page.locator('canvas').boundingBox();
  const bottom = vp.panY + (grown.y + grown.h) * vp.zoom;
  expect(bottom).toBeLessThanOrEqual(box!.height + 1);
  const margin = await pixel(page, 100, 850); // below the original image
  expect(margin.slice(0, 3)).toEqual([255, 255, 255]); // the (white) background fills the margin
  const shadowInMargin = await pixel(page, CX + 150, 800 + 30);
  expect(luma(shadowInMargin)).toBeLessThan(250); // and the shadow reaches into it
});

test('Auto expand canvas off keeps the original size (the shadow is clipped)', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Distance', 300);
  expect((await state(page)).frame.h).toBeGreaterThan(890);

  await page.getByRole('checkbox', { name: /Auto expand canvas/ }).click();
  await page.waitForTimeout(250);
  expect((await state(page)).frame).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  await page.getByRole('checkbox', { name: /Auto expand canvas/ }).click();
  await page.waitForTimeout(250);
  expect((await state(page)).frame.h).toBeGreaterThan(890);
});

test('the Before/After divider follows the expanded canvas', async ({ page }) => {
  await start(page);
  await prepare(page);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setCompare('split'),
  );
  await enable(page).click();
  await setField(page, 'Distance', 300);
  const s = await state(page);
  const handle = page.getByTestId('compare-handle');
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  const handleBox = await handle.boundingBox();
  const canvasBox = await page.locator('canvas').boundingBox();
  const vp = s.viewport!;
  const frameLeft = canvasBox!.x + vp.panX + s.frame.x * vp.zoom;
  const expected = frameLeft + 0.5 * s.frame.w * vp.zoom;
  expect(Math.abs(handleBox!.x + handleBox!.width / 2 - expected)).toBeLessThan(3);
});

test('undo and redo step through shadow edits, one step per drag', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Distance', 80);
  const layerDistance = async () => (await state(page)).shadow?.layers[0]?.distance;
  expect(await layerDistance()).toBe(80);

  await page.keyboard.press('Control+z');
  expect(await layerDistance()).toBe(24);
  await page.keyboard.press('Control+z');
  expect((await state(page)).shadow).toBeNull(); // back before it was ever enabled
  await page.keyboard.press('Control+Shift+z');
  expect((await state(page)).shadow?.enabled).toBe(true);
  await page.keyboard.press('Control+Shift+z');
  expect(await layerDistance()).toBe(80);
});

test('shadow settings are saved with the project, marked as a change, and restored on open', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await page.keyboard.press('Control+s');
  const title = page.locator('header').getByText(/\.photom/);
  await expect(title).toHaveText('test.photom');

  await enable(page).click();
  await setField(page, 'Distance', 77);
  await setField(page, 'Opacity', 60);
  await expect(title).toHaveText('test.photom *'); // a shadow edit is a project change
  await page.keyboard.press('Control+s');
  await expect(title).toHaveText('test.photom');

  const saved = await page.evaluate(
    () =>
      (window as unknown as Photom).__mock.files['/docs/test.photom']!.payload.images[0]!.state
        .shadow,
  );
  expect(saved).toMatchObject({
    enabled: true,
    autoExpand: true,
    layers: [{ type: 'drop', distance: 77, opacity: 0.6, angle: 135 }],
  });
  expect(JSON.stringify(saved)).not.toContain('"id"');

  await page.keyboard.press('Control+n');
  await page.keyboard.press('Control+Shift+O');
  await expect(title).toHaveText('test.photom');
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(400);
  const back = (await state(page)).shadow;
  expect(back?.enabled).toBe(true);
  expect(back?.layers[0]).toMatchObject({ distance: 77, opacity: 0.6 });
  await expect(title).toHaveText('test.photom'); // opening is not an edit
});

test('a project from before shadows existed opens with no shadow and no errors', async ({
  page,
}) => {
  await start(page);
  await openEditor(page);
  // The default mock project state has no shadow key at all: simulate an old file.
  await page.keyboard.press('Control+s');
  await page.evaluate(() => {
    const files = (window as unknown as Photom).__mock.files;
    for (const f of Object.values(files)) {
      for (const img of f.payload.images) delete img.state.shadow;
    }
  });
  await page.keyboard.press('Control+n');
  await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  expect((await state(page)).shadow).toBeNull();
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await expect(enable(page)).not.toBeChecked();
});

test('switching images keeps each image’s own shadow and frame', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Distance', 300);
  await page.getByRole('button', { name: 'Add Images' }).click();
  await expect(page.getByRole('button', { name: 'photo2.jpg' })).toBeVisible();
  await page.getByRole('button', { name: 'photo2.jpg' }).click();
  await page.waitForTimeout(300);
  const second = await state(page);
  expect(second.shadow).toBeNull();
  expect(second.frame).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.waitForTimeout(400);
  expect((await state(page)).shadow?.layers[0]?.distance).toBe(300);
  expect((await state(page)).frame.h).toBeGreaterThan(890);
});

async function addLayer(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Add a shadow layer' }).click();
  await page.getByRole('menuitem', { name }).click();
  await page.waitForTimeout(250);
}

const layerTypes = async (page: Page) => (await state(page)).shadow!.layers.map((l) => l.type);

test('a contact shadow darkens the floor just under the subject and nothing else', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await page.getByRole('button', { name: 'Hide Drop shadow' }).click();
  await addLayer(page, /Contact shadow/);
  expect(await layerTypes(page)).toEqual(['drop', 'contact']);
  // The disc's lowest point is y = 640. The contact shadow lies just below it.
  expect(luma(await pixel(page, CX, 646))).toBeLessThan(235);
  expect(luma(await pixel(page, CX, 720))).toBeGreaterThan(250);
  expect(luma(await pixel(page, 100, 646))).toBeGreaterThan(250);
});

test('a cast shadow runs along the floor away from the light and grows the canvas', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await page.getByRole('button', { name: 'Hide Drop shadow' }).click();
  await addLayer(page, /Cast shadow/);
  const before = await state(page);
  // Light from the left: the shadow lies to the right of the disc (which ends at x = 840).
  await setField(page, 'Light angle', 180);
  const s = await state(page);
  expect(s.frame.w).toBeGreaterThan(before.source.width);
  // The floor line sits at the disc's feathered lowest edge, a few pixels below y = 640.
  const darkest = async (x: number) => {
    let m = 255;
    for (let y = 638; y <= 652; y++) m = Math.min(m, luma(await pixel(page, x, y)));
    return m;
  };
  expect(await darkest(800)).toBeLessThan(235);
  expect(await darkest(1000)).toBeLessThan(250);
  expect(await darkest(200)).toBeGreaterThan(250);
});

test('the ground line handle moves the shadows; automatic detection can be restored', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await addLayer(page, /Contact shadow/);
  const handle = page.getByRole('slider', { name: 'Ground line' });
  await expect(handle).toBeVisible();
  expect((await state(page)).shadow!.groundY).toBeNull();
  const auto = Number(await handle.getAttribute('aria-valuenow')) / 100;
  await handle.focus();
  await handle.press('Shift+ArrowUp');
  const first = (await state(page)).shadow!.groundY!;
  expect(first).toBeCloseTo(auto - 10 / 800, 2);
  for (let i = 0; i < 2; i++) await handle.press('Shift+ArrowUp');
  await handle.press('ArrowDown');
  // Three 10 px steps up and one 1 px step down from wherever the line started.
  const g = (await state(page)).shadow!.groundY!;
  expect(g - first).toBeCloseTo(-19 / 800, 5);
  await page.getByRole('button', { name: 'Detect from the subject' }).click();
  expect((await state(page)).shadow!.groundY).toBeNull();
});

test('dragging the ground line is a single undo step', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await addLayer(page, /Contact shadow/);
  const handle = page.getByRole('slider', { name: 'Ground line' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  const moved = (await state(page)).shadow!.groundY!;
  expect(moved).toBeLessThan(0.8);
  await page.keyboard.press('Control+z');
  expect((await state(page)).shadow!.groundY).toBeNull();
});

test('the light handle sets one direction for every layer that has a light', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await addLayer(page, /Cast shadow/);
  const handle = page.getByRole('slider', { name: 'Light direction' });
  await expect(handle).toBeVisible();
  const s0 = await state(page);
  const vp = s0.viewport!;
  const host = (await page.locator('canvas').boundingBox())!;
  // Drag it to straight above the subject's centre: 90 degrees.
  const cx = host.x + vp.panX + CX * vp.zoom;
  const cy = host.y + vp.panY + CY * vp.zoom;
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 150, { steps: 8 });
  await page.mouse.up();
  const layers = (await state(page)).shadow!.layers as unknown as { angle: number }[];
  expect(layers.map((l) => Math.round(l.angle))).toEqual([90, 90]);
  await handle.focus();
  await handle.press('ArrowRight');
  expect(Math.round((await state(page)).shadow!.layers[0]!['angle' as never])).toBe(91);
});

test('layers can be reordered, and the order is what is drawn', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await addLayer(page, /Contact shadow/);
  expect(await layerTypes(page)).toEqual(['drop', 'contact']);
  await page.getByRole('button', { name: 'Move Contact shadow up' }).click();
  expect(await layerTypes(page)).toEqual(['contact', 'drop']);
  await expect(page.getByRole('button', { name: 'Move Contact shadow up' })).toBeDisabled();
  await page.keyboard.press('Control+z');
  expect(await layerTypes(page)).toEqual(['drop', 'contact']);
});

test('contact and cast layers are saved and restored', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await addLayer(page, /Contact shadow/);
  await addLayer(page, /Cast shadow/);
  await setField(page, 'Elevation', 25);
  const saved = (await state(page)).shadow!;
  expect(saved.layers.map((l) => l.type)).toEqual(['drop', 'contact', 'cast']);
  const { sanitizeShadow, shadowToPersisted } = await import('../src/canvas/shadow');
  const again = sanitizeShadow(JSON.parse(JSON.stringify(shadowToPersisted(saved))))!;
  expect(shadowToPersisted(again)).toEqual(shadowToPersisted(saved));
});

test('a reflection mirrors the subject under it in its own colours', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await page.getByRole('button', { name: 'Hide Drop shadow' }).click();
  await addLayer(page, /Reflection/);
  // The disc is orange on a white background; just under its lowest point the reflection is a
  // pale orange, not grey like a shadow.
  const near = await pixel(page, CX, 690);
  expect(near[0]).toBeGreaterThan(near[2] + 10); // warmer than white, and clearly orange-ish
  expect(luma(near)).toBeLessThan(250);
  expect(await pixel(page, 100, 690)).toEqual([255, 255, 255, 255]);
  // It fades with distance.
  const far = await pixel(page, CX, 830);
  expect(luma(far)).toBeGreaterThan(luma(near) + 4);
});

test('presets: Grounded replaces the layers, one undo brings the old shadow back', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  const presets = page.getByRole('group', { name: 'Preset' });
  await presets.getByRole('button', { name: 'Grounded' }).click();
  expect(await layerTypes(page)).toEqual(['contact', 'cast']);
  await expect(presets.getByRole('button', { name: 'Grounded' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Control+z');
  expect(await layerTypes(page)).toEqual(['drop']);
});

test('a custom preset is saved, listed after a reload of settings, and can be deleted', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await page.getByRole('button', { name: 'Save as preset' }).click();
  await page.getByRole('textbox', { name: 'Preset name' }).fill('Boots');
  await page.keyboard.press('Enter');
  const presets = page.getByRole('group', { name: 'Preset' });
  await expect(presets.getByRole('button', { name: 'Boots' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const saved = await page.evaluate(
    () =>
      (window as unknown as { __mock: { settings: { shadowPresets: unknown[] } } }).__mock.settings
        .shadowPresets,
  );
  expect(saved).toHaveLength(1);
  await page.getByRole('button', { name: /Delete preset/ }).click();
  await expect(presets.getByRole('button', { name: 'Boots' })).toHaveCount(0);
});

test('Shadow only hides the subject and background and shows the shadow on grey', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Distance', 60);
  const subjectPx = await pixel(page, CX, CY);
  expect(subjectPx[0]).toBeGreaterThan(subjectPx[2] + 80); // the orange subject is drawn
  await page.getByRole('checkbox', { name: /Shadow only/ }).click();
  await page.waitForTimeout(150);
  const centre = await pixel(page, CX, CY);
  expect(Math.abs(centre[0] - centre[2])).toBeLessThan(40); // no orange subject any more
  const bare = await pixel(page, 40, 40); // empty corner: the neutral grey
  expect(bare[0]).toBe(bare[1]);
  expect(bare[0]).toBeLessThan(240);
  expect(bare[0]).toBeGreaterThan(180);
  const inside = await pixel(page, CX + 150, CY + 150); // under the shadow, subject not drawn
  expect(luma(inside)).toBeLessThan(luma(bare));
  await page.getByRole('checkbox', { name: /Shadow only/ }).click();
  await page.waitForTimeout(150);
  expect(await pixel(page, 40, 40)).toEqual([255, 255, 255, 255]);
});

test('Apply to all images: a job with progress; images with a cut-out take the shadow, others are skipped', async ({
  page,
}) => {
  await start(page);
  await prepare(page);
  for (let i = 2; i <= 3; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await expect(page.getByRole('button', { name: `photo${i}.jpg` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.waitForTimeout(200);
  // photo2 has a cut-out, photo3 does not.
  await page.evaluate(() => {
    const p = (window as unknown as Photom).__photom.project.getState();
    p.setMask({
      id: 'img2',
      maskPath: '/m2.png',
      width: 10,
      height: 10,
      boundingBox: null,
      durationMs: 1,
      device: 'cpu',
    });
  });
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await enable(page).click();
  await page
    .getByRole('group', { name: 'Preset' })
    .getByRole('button', { name: 'Grounded' })
    .click();

  await page.getByRole('button', { name: 'Apply to all images' }).click();
  const d = page.getByRole('dialog', { name: 'Applying the shadow' });
  await expect(d).toBeVisible();
  await expect(d.getByRole('button', { name: /Close|Done/ }).first()).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByText(/1 image has no cut-out yet and was skipped/)).toBeVisible();
  await expect(page.getByText('Shadow applied to 1 of 1 image')).toBeVisible();

  const shadows = await page.evaluate(() => {
    const s = (window as unknown as Photom).__photom.editor.getState().states;
    return Object.fromEntries(
      Object.entries(s).map(([id, v]) => [
        id,
        v.shadow && { preset: v.shadow.presetId, types: v.shadow.layers.map((l) => l.type) },
      ]),
    );
  });
  expect(shadows.img2).toEqual({ preset: 'grounded', types: ['contact', 'cast'] });
  expect(shadows.img3 ?? null).toBeNull(); // skipped: untouched
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __mock: { shadowBatches: { items: { id: string }[] }[] } }).__mock
        .shadowBatches,
  );
  expect(calls[0]!.items.map((i) => i.id)).toEqual(['img2']);
});

test('Apply to all needs at least one other image', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await expect(page.getByRole('button', { name: 'Apply to all images' })).toBeDisabled();
});

test('the shadow looks the same in the light and dark themes', async ({ page }) => {
  await start(page);
  await prepare(page);
  await enable(page).click();
  await setField(page, 'Blur', 0);
  const probe = [CX + 160, CY + 160] as const; // inside the shadow, outside the subject
  const light = await pixel(page, probe[0], probe[1]);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(250);
  const dark = await pixel(page, probe[0], probe[1]);
  expect(luma(light)).toBeLessThan(250); // it really is shadow
  expect(dark).toEqual(light); // the canvas colours do not follow the UI theme
});

test('journey: remove the background, add a shadow, compare, export, and the export carries exactly what the editor shows', async ({
  page,
}) => {
  await start(page);
  await openEditor(page);
  await page.getByRole('button', { name: 'Remove BG' }).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ed = (window as unknown as Photom).__photom.editor.getState();
    ed.setBackground('img1', { kind: 'solid', color: '#ffffff' });
  });

  // Add a shadow from a preset and tweak it.
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await enable(page).click();
  await page
    .getByRole('group', { name: 'Preset' })
    .getByRole('button', { name: 'Product' })
    .click();
  await setField(page, 'Distance', 40);

  // Compare: left of the divider is the untouched original, right of it the result with shadow.
  await page.evaluate(() => {
    const ed = (window as unknown as Photom).__photom.editor.getState();
    ed.setCompare('split');
    ed.setSplit('img1', 0.5);
  });
  await page.waitForTimeout(250);
  const original = await pixel(page, 100, CY); // left half: the blue photo
  expect(original[2]).toBeGreaterThan(original[0]);
  const after = await pixel(page, 1100, CY + 300); // right half, well away from the subject: white
  expect(after).toEqual([255, 255, 255, 255]);
  const shadowed = await pixel(page, CX + 170, CY + 170); // right half, inside the shadow
  expect(luma(shadowed)).toBeLessThan(luma(after));
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setCompare('after'),
  );

  // Export with the shadow on its own layer too.
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('textbox', { name: 'Folder' }).fill('/exports');
  await d.getByRole('checkbox', { name: 'Shadow on separate layer' }).click();
  await d.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const { sent, editor } = await page.evaluate(() => {
    const w = window as unknown as Photom & {
      __mock: { exports: { items: { state: { shadow: unknown } }[]; options: unknown }[] };
    };
    const s = w.__photom.editor.getState();
    return { sent: w.__mock.exports[0]!, editor: s.states[s.activeId!]!.shadow };
  });
  expect(sent.options).toMatchObject({ includeShadow: true, shadowLayer: true });
  const persisted = sent.items[0]!.state.shadow as {
    layers: { type: string; distance?: number }[];
    presetId: string | null;
  };
  // What the export receives is the editor's shadow, to the last slider value.
  expect(persisted.layers.map((l) => l.type)).toEqual(editor!.layers.map((l) => l.type));
  expect(persisted.layers[0]!.distance).toBeCloseTo(40, 5);
  expect(persisted.presetId).toBeNull(); // edited after choosing the preset: Custom
  expect(JSON.stringify(persisted)).not.toContain('"id"'); // no editor-only keys leak out
});
