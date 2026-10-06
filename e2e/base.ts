import { expect, test as base } from '@playwright/test';

/**
 * Every e2e test fails if the app logs a console error or throws an uncaught exception
 * ("no console errors" is an acceptance criterion).
 */
export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
      await use();
      expect(problems, 'the app must not log errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
