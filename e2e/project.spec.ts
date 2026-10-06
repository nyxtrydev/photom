import type { Page } from '@playwright/test';
import { expect, test } from './base';
import type { useEditorStore } from '../src/stores/editorStore';
import type { useProjectStore } from '../src/stores/projectStore';
import type { useSettingsStore } from '../src/stores/settingsStore';
import type { useUiStore } from '../src/stores/uiStore';
import { installTauriMock, type MockOptions } from './tauriMock';

type Photom = {
  __photom: {
    editor: typeof useEditorStore;
    project: typeof useProjectStore;
    settings: typeof useSettingsStore;
    ui: typeof useUiStore;
  };
  __mock: { calls: string[]; autosaves: unknown[]; files: Record<string, unknown> };
};
type Rgb = [number, number, number, number];

async function start(page: Page, options: MockOptions = {}) {
  await page.addInitScript(installTauriMock, options);
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
}

async function openImage(page: Page) {
  await page.getByRole('button', { name: 'Open Images' }).click();
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(150);
}

const title = (page: Page) => page.locator('header').getByText(/\.photom/);
const ed = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as Photom).__photom.editor.getState();
    return st.states[st.activeId!]!;
  });

async function pixel(page: Page, srcX: number, srcY: number): Promise<Rgb> {
  const s = await ed(page);
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

/** A visible edit: Remove BG, After-only view, solid green background, edge shift. */
async function makeEdits(page: Page) {
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setCompare('after'),
  );
  await page.getByRole('radio', { name: 'Solid color' }).click();
  const hex = page.getByRole('textbox', { name: 'Hex color' });
  await hex.fill('#00ff00');
  await hex.press('Enter');
  const edge = page.getByRole('textbox', { name: 'Edge shift value' });
  await edge.fill('7');
  await edge.press('Enter');
  await page.waitForTimeout(250);
}

test('Save As writes the project, clears the asterisk, and reopening restores identical results', async ({
  page,
}) => {
  await start(page);
  await openImage(page);
  await expect(title(page)).toHaveText('Untitled.photom *');
  await makeEdits(page);
  const before = await ed(page);
  const greenBefore = await pixel(page, 100, 100);
  expect(greenBefore.slice(0, 3)).toEqual([0, 255, 0]);

  await page.keyboard.press('Control+s'); // untitled -> Save As dialog (mocked path)
  await expect(title(page)).toHaveText('test.photom');
  expect(
    await page.evaluate(() => (window as unknown as Photom).__mock.calls.includes('save_project')),
  ).toBe(true);

  // Start over, then open the project again.
  await page.keyboard.press('Control+n');
  await expect(page.getByText('Drag & drop images here')).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  await expect(title(page)).toHaveText('test.photom');
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(300);

  const after = await ed(page);
  expect(after.refine).toEqual(before.refine);
  expect(after.background).toEqual(before.background);
  expect(after.output).toEqual(before.output);
  expect(after.strokes).toEqual(before.strokes);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.editor.getState().setCompare('after'),
  );
  await page.waitForTimeout(100);
  expect((await pixel(page, 100, 100)).slice(0, 3)).toEqual([0, 255, 0]); // same render
  await expect(title(page)).toHaveText('test.photom'); // opening is not an edit
});

test('editing a saved project shows the asterisk until it is saved again', async ({ page }) => {
  await start(page);
  await openImage(page);
  await page.keyboard.press('Control+s');
  await expect(title(page)).toHaveText('test.photom');

  const feather = page.getByRole('textbox', { name: 'Feather value' });
  await feather.fill('11');
  await feather.press('Enter');
  await expect(title(page)).toHaveText('test.photom *');
  // Panning/zooming is not an edit.
  await page.keyboard.press('Control+s');
  await expect(title(page)).toHaveText('test.photom');
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await expect(title(page)).toHaveText('test.photom');
});

test("unsaved-changes guard: Cancel keeps work, Save then continues, Don't save discards", async ({
  page,
}) => {
  await start(page);
  await openImage(page);
  await page.keyboard.press('Control+n');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Unsaved changes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible(); // still editing

  await page.keyboard.press('Control+n');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click(); // saves via Save As, then New
  await expect(page.getByText('Drag & drop images here')).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys((window as unknown as Photom).__mock.files)),
  ).toEqual(['/docs/test.photom']);

  await openImage(page);
  await page.keyboard.press('Control+n');
  await page.getByRole('dialog').getByRole('button', { name: "Don't save" }).click();
  await expect(page.getByText('Drag & drop images here')).toBeVisible();
});

test('crash recovery: leftover autosave is offered at startup and restores unsaved work', async ({
  page,
}) => {
  const payload = {
    projectId: 'proj-crash',
    name: 'Crashed work',
    activeId: 'img1',
    originalPath: null,
    images: [
      {
        id: 'img1',
        state: {
          refine: { threshold: 50, feather: 9, edgeShift: 0 },
          background: { kind: 'solid', color: '#00ff00', image: null, fit: 'cover' },
          output: { width: 1200, height: 800, lockRatio: true, cropToSubject: false },
          strokes: [{ mode: 'erase', size: 30, hardness: 50, points: [[10, 10, 1]] }],
          split: 0.5,
        },
      },
    ],
  };
  await start(page, {
    recovery: [
      {
        entry: {
          id: 'proj-crash',
          name: 'Crashed work',
          savedAt: new Date().toISOString(),
          originalPath: null,
          imageCount: 1,
        },
        payload,
        hasMask: true,
      },
    ],
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Recover unsaved work?')).toBeVisible();
  await expect(dialog.getByText('Crashed work')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore' }).click();

  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await expect(title(page)).toHaveText('Crashed work.photom *'); // restored work counts as unsaved
  const s = await ed(page);
  expect(s.refine.feather).toBe(9);
  expect(s.strokes).toHaveLength(1);
  expect(s.background.color).toBe('#00ff00');
});

test('recovery can be discarded', async ({ page }) => {
  await start(page, {
    recovery: [
      {
        entry: {
          id: 'p',
          name: 'Old',
          savedAt: new Date().toISOString(),
          originalPath: null,
          imageCount: 1,
        },
        payload: { projectId: 'p', name: 'Old', activeId: null, images: [] },
        hasMask: false,
      },
    ],
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  // Discarding is destructive, so it asks first.
  await expect(page.getByText('Discard recovered work?')).toBeVisible();
  await page
    .getByRole('dialog')
    .filter({ hasText: 'Discard recovered work?' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(
    await page.evaluate(() =>
      (window as unknown as Photom).__mock.calls.filter((c) => c === 'discard_recovery'),
    ),
  ).toHaveLength(1);
});

test('autosave runs in the background only while there are unsaved changes', async ({ page }) => {
  await start(page);
  await page.evaluate(() =>
    (window as unknown as Photom).__photom.settings.setState({ autosaveSeconds: 1 }),
  );
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as Photom).__mock.autosaves.length)).toBe(0); // clean + empty

  await openImage(page); // image added => dirty
  await expect(page.getByText(/^Autosaved \d\d:\d\d$/)).toBeVisible({ timeout: 4000 });
  const n = await page.evaluate(() => (window as unknown as Photom).__mock.autosaves.length);
  expect(n).toBeGreaterThanOrEqual(1);

  await page.keyboard.press('Control+s'); // clean again
  await expect(title(page)).toHaveText('test.photom');
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => (window as unknown as Photom).__mock.autosaves.length)).toBe(n);
});

test('settings persist (theme) and shortcuts can be remapped and then used', async ({ page }) => {
  await start(page);
  await openImage(page);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: /Reset refine/ }).waitFor();
  await page.keyboard.press('Escape');

  // Make an undoable edit.
  const feather = page.getByRole('textbox', { name: 'Feather value' });
  await feather.fill('12');
  await feather.press('Enter');
  expect((await ed(page)).refine.feather).toBe(12);

  // Remap Undo -> Ctrl+U in Settings.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('tab', { name: 'Shortcuts' }).click();
  await page.getByRole('button', { name: 'Change Undo' }).click();
  await page.keyboard.press('Control+u');
  await expect(page.getByText('Press keys...')).toBeHidden();
  expect(
    await page.evaluate(() => (window as unknown as Photom).__photom.settings.getState().shortcuts),
  ).toEqual({ undo: ['mod+u'] });
  await page.keyboard.press('Escape'); // close dialog

  await page.keyboard.press('Control+z'); // old key no longer undoes
  expect((await ed(page)).refine.feather).toBe(12);
  await page.keyboard.press('Control+u'); // new key does
  expect((await ed(page)).refine.feather).toBe(2);
});

test('settings dialog: changing the theme applies immediately and is saved', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(
    await page.evaluate(() => (window as unknown as Photom).__photom.settings.getState().theme),
  ).toBe('dark');
});
