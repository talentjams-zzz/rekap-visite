// Self-healing UI: a transient API failure ("TypeError: Failed to fetch")
// must NOT blank the page. The last data stays visible, an error banner with
// a Retry button appears, and the page recovers by itself once the API
// responds (5 s auto-retry).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, rowFor, uploadFiles } from '../helpers/ui.js';

const MR = '770100';

test('transient API failure: banner + last data kept + auto recovery', async ({ server, page }) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'RECOVER', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  // The upload's reload is coalesced (150 ms) — wait for the real row,
  // not just "a row" (the empty-state placeholder would satisfy that too).
  await expect(page.locator('table tbody tr').filter({ hasText: MR })).toBeVisible();

  // Sabotage every rows API call (simulates "Failed to fetch").
  await page.route('**/api/rows**', (route) => route.abort());

  // Any write now fails; its fallback reload() hits the broken API and
  // surfaces the error banner.
  const row = rowFor(page, MR);
  await row.locator('button', { hasText: 'TR' }).first().click();

  // Banner visible — and the row is STILL rendered (no dead/empty page).
  await expect(page.locator('text=/API error/')).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(1);

  // API returns → the 5 s auto-retry heals the page without a refresh.
  await page.unroute('**/api/rows**');
  await expect(page.locator('text=/API error/')).toHaveCount(0, { timeout: 20000 });
  await expect(page.locator('table tbody tr')).toHaveCount(1);
});
