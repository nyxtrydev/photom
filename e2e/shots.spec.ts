import { test } from './base';
import { installTauriMock } from './tauriMock';

test('screenshots', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'manual: SHOTS=dir npx playwright test shots');
  const dir = process.env.SHOTS!;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(installTauriMock, { failIds: ['img3'], tickMs: 700 });
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await page.screenshot({ path: dir + '/home.png' });
  await page.getByRole('button', { name: 'Open Images' }).click();
  for (let i = 2; i <= 5; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await page.getByRole('button', { name: `photo${i}.jpg` }).waitFor();
  }
  await page.getByRole('button', { name: 'photo1.jpg' }).click();
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: dir + '/editor.png' });
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder' }).fill('/Users/me/Pictures/Photom');
  await page.getByRole('checkbox', { name: 'Crop to subject' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: dir + '/export.png' });
  await page.getByRole('radio', { name: /All images/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForTimeout(3600);
  await page.screenshot({ path: dir + '/batch.png' });
  await page.waitForTimeout(3500);
  await page.getByRole('button', { name: /Close|Hide/ }).click();
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: dir + '/history.png' });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('tab', { name: 'Shortcuts' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: dir + '/settings.png' });
});
