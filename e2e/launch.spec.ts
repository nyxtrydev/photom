import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock } from './tauriMock';

type Mock = { files: Record<string, unknown> };

/** Pre-seed a saved project on the fake disk, as if the user had one. */
async function seed(page: Page) {
  await page.evaluate(() => {
    const m = (window as unknown as { __mock: Mock }).__mock;
    m.files['/docs/test.photom'] = {
      payload: {
        projectId: 'p1',
        name: 'test',
        activeId: 'img1',
        images: [{ id: 'img1', state: { refine: { threshold: 61, feather: 4, edgeShift: 0 } } }],
      },
      meta: { hasMask: true },
    };
  });
}

test('double-clicking a .photom file opens it straight away (no recovery prompt first)', async ({
  page,
}) => {
  // The mock's "disk" must contain the project before the app asks for it.
  await page.addInitScript(installTauriMock, { launchFile: '/docs/test.photom' });
  await page.addInitScript(() => {
    const w = window as unknown as { __mock: Mock };
    w.__mock.files['/docs/test.photom'] = {
      payload: {
        projectId: 'p1',
        name: 'test',
        activeId: 'img1',
        images: [{ id: 'img1', state: { refine: { threshold: 61, feather: 4, edgeShift: 0 } } }],
      },
      meta: { hasMask: true },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await expect(page.locator('header').getByText('test.photom')).toBeVisible();
  const refine = await page.evaluate(() => {
    const s = (
      window as unknown as {
        __photom: {
          editor: { getState: () => { states: Record<string, { refine: { threshold: number } }> } };
        };
      }
    ).__photom.editor.getState();
    return s.states['img1']!.refine.threshold;
  });
  expect(refine).toBe(61);
});

test('a project opened by the OS while Photom is running is opened (with the unsaved-changes guard)', async ({
  page,
}) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await seed(page);
  // Simulate the backend's `app:open-file` event.
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (e: string, p: unknown) => void };
    w.__emit('app:open-file', '/docs/test.photom');
  });
  await expect(page.locator('header').getByText('test.photom')).toBeVisible();
});

test('opening another project while there are unsaved changes asks first', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await seed(page);
  await page.getByRole('button', { name: 'Open Images' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
      'app:open-file',
      '/docs/test.photom',
    ),
  );
  await expect(page.getByRole('dialog').getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('header').getByText('Untitled.photom *')).toBeVisible();
});
