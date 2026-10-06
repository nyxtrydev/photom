import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock } from './tauriMock';

type Mock = {
  calls: string[];
  exports: { options: Record<string, unknown> }[];
  files: Record<string, unknown>;
};
const mock = (page: Page) => page.evaluate(() => (window as unknown as { __mock: Mock }).__mock);

/** Accessible name of the focused element. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() : '';
  });

/** Press Tab until the focused element's name matches (fails if it is unreachable by keyboard). */
async function tabTo(page: Page, name: RegExp | string, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const n = await focusedName(page);
    if (typeof name === 'string' ? n === name : name.test(n)) return;
  }
  throw new Error(`"${name}" could not be reached with Tab within ${max} presses`);
}

test('core flow works with the keyboard only: import, cut out, export, save', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);

  // 1. Import: reach "Open Images" with Tab and press Enter.
  await tabTo(page, 'Open Images');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await page.waitForTimeout(300);

  // 2. Cut out with the shortcut.
  await page.keyboard.press('Control+r');
  await expect(page.getByText('Press Remove BG to cut out the subject.')).toBeHidden();

  // 3. Export with the shortcut; the dialog is fully keyboard operable.
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('dialog').getByText('Export PNG')).toBeVisible();
  await tabTo(page, 'Folder');
  await page.keyboard.type('/exports');
  await tabTo(page, 'Export');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
  const m = await mock(page);
  expect(m.calls).toContain('export_png');
  expect(m.exports[0]!.options).toMatchObject({ folder: '/exports' });

  // 4. Save with the shortcut (untitled -> Save As).
  await page.keyboard.press('Control+s');
  await expect(page.locator('header').getByText('test.photom')).toBeVisible();
  expect(Object.keys((await mock(page)).files)).toEqual(['/docs/test.photom']);
});

test('dialogs trap focus, close with Escape and give focus back', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();

  const exportBtn = page.getByRole('button', { name: 'Export PNG', exact: true });
  await exportBtn.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Focus stays inside while tabbing around.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    );
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(exportBtn).toBeFocused(); // focus returns to what opened it
});

test('menus work from the keyboard (open, arrow, select, close)', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();

  await page.getByRole('button', { name: 'View' }).focus();
  await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name: /Fit to screen/ });
  await expect(item).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
  await expect(page.getByRole('button', { name: 'View' })).toBeFocused();
});

test('every interactive control shows a visible focus ring', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await page.waitForTimeout(300);

  const outlined = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20),
        style: cs.outlineStyle,
        width: parseFloat(cs.outlineWidth),
      };
    });

  const seen = new Set<string>();
  const missing: string[] = [];
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press('Tab');
    const o = await outlined();
    if (!o) continue;
    const key = `${o.tag}:${o.name}`;
    seen.add(key);
    // Radix sliders/radios draw their own ring; the app-wide rule is a 2px outline.
    if (o.style === 'none' || o.width < 2) missing.push(key);
  }
  expect(seen.size).toBeGreaterThan(25);
  expect(missing, 'focusable controls without a visible focus ring').toEqual([]);
});

test('respects prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  const d = await page.evaluate(() => {
    const el = document.querySelector('button')!;
    return getComputedStyle(el).transitionDuration;
  });
  // 0.01ms is the app's "effectively none" override.
  expect(parseFloat(d)).toBeLessThanOrEqual(0.001);
});
