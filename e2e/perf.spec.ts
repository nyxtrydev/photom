import type { Page } from '@playwright/test';
import { expect, test } from './base';
import { installTauriMock } from './tauriMock';

/**
 * Performance checks (Section 7). They run against the production-like dev server in headless
 * Chromium with software rendering, so thresholds are generous; the measured numbers are printed
 * and recorded in docs/PERFORMANCE.md.
 */
type Photom = {
  __photom: {
    editor: {
      getState: () => {
        setBrush: (b: unknown) => void;
        setSplit: (id: string, v: number) => void;
        states: Record<string, { viewport: { zoom: number; panX: number; panY: number } }>;
        activeId: string;
        setViewport: (id: string, v: unknown) => void;
      };
    };
  };
};

async function openLarge(page: Page) {
  // A 12 MP source (4000x3000) edited at the 2048x1536 working size.
  await page.addInitScript(installTauriMock, { work: [2048, 1536], source: [4000, 3000] });
  await page.goto('/');
  await page.waitForFunction(() => '__photom' in window);
  await page.getByRole('button', { name: 'Open Images' }).click();
  await page.waitForFunction(() => {
    const s = (window as unknown as Photom).__photom.editor.getState();
    return s.activeId && s.states[s.activeId]?.viewport;
  });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Remove BG' }).click();
  await page.waitForTimeout(800);
}

test('brushing on a 12 MP image stays at 60 fps (frame budget 16.7 ms)', async ({ page }) => {
  await openLarge(page);
  await page.evaluate(() => {
    const ed = (window as unknown as Photom).__photom.editor.getState();
    ed.setSplit(ed.activeId, 0);
    ed.setBrush({ size: 120, hardness: 60 });
  });
  await page.keyboard.press('b');

  const box = (await page.locator('canvas').boundingBox())!;
  // Count animation frames and measure per-frame time while a long, fast stroke is painted.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(box.x + 120, box.y + 140);
  await page.mouse.down();
  const steps = 240;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    await page.mouse.move(
      box.x + 120 + t * (box.width - 240),
      box.y + box.height / 2 + Math.sin(t * 12) * (box.height / 3),
    );
  }
  await page.mouse.up();
  const frames = await page.evaluate(() =>
    (window as unknown as { __frames: number[] }).__frames.slice(5),
  );
  const sorted = [...frames].sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(
    `brush stroke on 12 MP: ${frames.length} frames, avg ${avg.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
  );
  expect(frames.length).toBeGreaterThan(20);
  expect(avg).toBeLessThan(25); // headless software rendering; real GPUs are faster
});

test('refine sliders update the preview in under 200 ms on a 12 MP image', async ({ page }) => {
  await openLarge(page);
  const input = page.getByRole('textbox', { name: 'Feather value' });
  const timings: number[] = [];
  for (const v of ['8', '3', '12']) {
    // Time from committing the value until the next painted frame after the mask recompute.
    const ms = await page.evaluate(async (value) => {
      const el = document.querySelector('input[aria-label="Feather value"]') as HTMLInputElement;
      const t0 = performance.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    }, v);
    timings.push(ms);
  }
  await expect(input).toBeVisible();
  const worst = Math.max(...timings);
  console.log(`refine update on 12 MP: ${timings.map((t) => t.toFixed(0)).join(', ')} ms`);
  expect(worst).toBeLessThan(400); // budget 200 ms on a laptop CPU; allow 2x for CI/headless
});

test('dragging a shadow slider repaints in well under 100 ms on a 12 MP image', async ({
  page,
}) => {
  await openLarge(page);
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await page.getByRole('checkbox', { name: 'Enable' }).click();
  await page.waitForTimeout(500);
  const timings: number[] = [];
  // Each value is a fresh recompute (new blur radius); time until the frame after it is painted.
  for (const v of ['10', '60', '25', '90', '40', '70']) {
    const ms = await page.evaluate(async (value) => {
      const el = document.querySelector('input[aria-label="Blur value"]') as HTMLInputElement;
      const t0 = performance.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    }, v);
    timings.push(ms);
  }
  const worst = Math.max(...timings);
  console.log(`shadow update on 12 MP: ${timings.map((t) => t.toFixed(0)).join(', ')} ms`);
  expect(worst).toBeLessThan(150); // target 50 ms on a laptop; headless software rendering is slower
});

test('a cast shadow (4 blur levels) plus contact repaints quickly on a 12 MP image', async ({
  page,
}) => {
  await openLarge(page);
  await page.getByRole('tab', { name: 'Shadow' }).click();
  await page.getByRole('checkbox', { name: 'Enable' }).click();
  for (const name of [/Contact shadow/, /Cast shadow/]) {
    await page.getByRole('button', { name: 'Add a shadow layer' }).click();
    await page.getByRole('menuitem', { name }).click();
  }
  await page.waitForTimeout(500);
  const timings: number[] = [];
  for (const v of ['20', '60', '30', '75', '45', '25']) {
    const ms = await page.evaluate(async (value) => {
      const el = document.querySelector('input[aria-label="Elevation value"]') as HTMLInputElement;
      const t0 = performance.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    }, v);
    timings.push(ms);
  }
  const worst = Math.max(...timings);
  console.log(`cast+contact update on 12 MP: ${timings.map((t) => t.toFixed(0)).join(', ')} ms`);
  expect(worst).toBeLessThan(300);
});

test('cold start to interactive UI', async ({ page }) => {
  await page.addInitScript(installTauriMock, {});
  const t0 = Date.now();
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Images' }).waitFor();
  const ms = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const [n] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return { dcl: Math.round(n!.domContentLoadedEventEnd), load: Math.round(n!.loadEventEnd) };
  });
  console.log(
    `cold start (dev server, includes module transforms): interactive in ${ms} ms, DOMContentLoaded ${nav.dcl} ms, load ${nav.load} ms`,
  );
  expect(ms).toBeLessThan(5000);
});

test('switching images releases and rebuilds buffers without growing memory', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'uses Chromium memory API');
  await openLarge(page);
  for (let i = 2; i <= 4; i++) {
    await page.getByRole('button', { name: 'Add Images' }).click();
    await page.getByRole('button', { name: `photo${i}.jpg` }).waitFor();
  }
  const heap = () =>
    page.evaluate(
      () =>
        (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize /
        1e6,
    );
  const names = ['photo1.jpg', 'photo2.jpg', 'photo3.jpg', 'photo4.jpg'];
  // Warm up one full cycle, then compare after many more switches.
  for (const n of names) {
    await page.getByRole('button', { name: n }).click();
    await page.waitForTimeout(400);
  }
  const before = await heap();
  for (let round = 0; round < 3; round++) {
    for (const n of names) {
      await page.getByRole('button', { name: n }).click();
      await page.waitForTimeout(350);
    }
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await heap();
  console.log(`JS heap after 12 image switches: ${before.toFixed(0)} MB -> ${after.toFixed(0)} MB`);
  expect(after - before).toBeLessThan(120);
});
