// Ports v1 test_aso.py + test_aso_alert.py:
// meds-to-stop list, due highlighting, top alert banner, confirm-stopped.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, rowFor, uploadFiles } from '../helpers/ui.js';

const MR = '770001';

test('aso: add due med → banner; confirm stopped → banner clears', async ({ server, page }) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'ASOPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));

  // No banner while there are no due meds.
  expect(await page.locator('text=ASO Alert').count()).toBe(0);

  const row = rowFor(page, MR);
  await row.locator('button', { hasText: '+ Add med' }).click();
  await row.locator("input[placeholder='Med name']").fill('ketorolac');
  await row.locator("input[type='date']").fill('2026-10-01'); // in the past → due

  // Due badge in the cell + top banner with count 1.
  await page.waitForSelector(`tr >> text=⚠ 1 due to stop`);
  const banner = page.locator('div', { hasText: 'ASO Alert' }).first();
  expect((await banner.innerText()).includes('1 med')).toBeTruthy();

  // Confirm stopped → due badge + banner disappear.
  await row.locator('button', { hasText: '✓' }).click();
  await page.waitForTimeout(600);
  expect(await row.locator('text=due to stop').count()).toBe(0);
  expect(await page.locator('text=ASO Alert').count()).toBe(0);

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
  await row.locator('button', { hasText: '+ Add med' }).click();
  await row.locator("input[placeholder='Med name']").fill('ceftriaxon');
  await row.locator("input[type='date']").fill('2027-01-01'); // future → not due
  expect(await page.locator('text=ASO Alert').count()).toBe(0);
  expect(await row.locator('text=due to stop').count()).toBe(0);

  await row.locator('button[title="Remove"]').click();
  await page.waitForTimeout(400);
  expect(await row.locator("input[placeholder='Med name']").count()).toBe(0);
});
