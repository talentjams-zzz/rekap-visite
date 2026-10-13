// Light/dark mode switch: toggles the .dark class on <html> (the whole UI
// colors off CSS vars, so the class swap IS the theme change) and persists.
import { test, expect } from '../helpers/fixture.js';

test('theme: toggle switches dark mode and persists the choice', async ({ server, page }) => {
  const { base } = server;
  await page.goto(base, { waitUntil: 'load' });

  const toggle = page.locator('button[title*="mode"]');
  await expect(toggle).toHaveCount(1);

  // Default is light (V1 look).
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await toggle.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('rekap-theme'))).toBe('dark');

  // The table header stays a dark surface in both modes; the page bg flips.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('');

  // Toggle back to light.
  await toggle.click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('rekap-theme'))).toBe('light');
});
