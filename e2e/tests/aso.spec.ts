// Ports v1 test_aso.py + test_aso_alert.py:
// meds-to-stop list, due highlighting, ASO filter-button warning, confirm-stopped.
// (The v1 top banner was moved onto the ASO filter button by request.)
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, rowFor, uploadFiles } from '../helpers/ui.js';

const MR = '770001';

// The ASO pill is theme-var colored (red in light, red-500 in dark), so
// assert on the computed color, not the class string.
async function isRed(btn: import('@playwright/test').Locator) {
  const c = await btn.evaluate((el) => getComputedStyle(el).color);
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return !!m && Number(m[1]) > 150 && Number(m[2]) < 100 && Number(m[3]) < 100;
}

test('aso: add due med → banner; confirm stopped → banner clears', async ({ server, page }) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'ASOPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));

  // No warning while there are no due meds (neutral pill, count 0).
  const asoBtn = page.locator('button', { hasText: /^ASO ⚠/ });
  expect(await asoBtn.innerText()).toContain('(0)');
  await expect.poll(() => isRed(asoBtn)).toBe(false);

  const row = rowFor(page, MR);
  await row.locator('button', { hasText: '+ Add med' }).click();
  await row.locator("input[placeholder='Med name']").fill('ketorolac');
  await row.locator("input[type='date']").fill('2026-10-01'); // in the past → due

  // Due badge in the cell + the filter pill turns red with count 1.
  await page.waitForSelector(`tr >> text=⚠ 1 due to stop`);
  await expect(asoBtn).toHaveText(/ASO ⚠ \(1\)/);
  await expect.poll(() => isRed(asoBtn)).toBe(true); // pill has transition-colors — poll until the color settles

  // Confirm stopped → due badge + red warning disappear.
  await row.locator('button', { hasText: '✓' }).click();
  await page.waitForTimeout(600);
  expect(await row.locator('text=due to stop').count()).toBe(0);
  await expect(asoBtn).toHaveText(/ASO ⚠ \(0\)/);
  await expect.poll(() => isRed(asoBtn)).toBe(false);

  // Remove the med entirely.
  await row.locator('button[title="Remove"]').click();
  await page.waitForTimeout(400);
  expect(await row.locator("input[placeholder='Med name']").count()).toBe(0);
});

test('aso: future stopDate is not due; removed med decrements banner', async ({ server, page }) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'melati', '12-10-26', [
    { mr: MR, nama: 'ASOPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));
  await page.locator('nav button', { hasText: 'Melati' }).click();

  const row = rowFor(page, MR);
  const asoBtn = page.locator('button', { hasText: /^ASO ⚠/ });
  await row.locator('button', { hasText: '+ Add med' }).click();
  await row.locator("input[placeholder='Med name']").fill('ceftriaxon');
  await row.locator("input[type='date']").fill('2027-01-01'); // future → not due
  await expect(asoBtn).toHaveText(/ASO ⚠ \(0\)/);
  await expect.poll(() => isRed(asoBtn)).toBe(false);
  expect(await row.locator('text=due to stop').count()).toBe(0);

  await row.locator('button[title="Remove"]').click();
  await page.waitForTimeout(400);
  expect(await row.locator("input[placeholder='Med name']").count()).toBe(0);
});
