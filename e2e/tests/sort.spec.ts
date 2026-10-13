// Ports v1 test_tglreg_time_sort.py:
// Tgl Reg sorts by date AND time; date-only values sort as 00:00:00.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { waitRows, uploadFiles } from '../helpers/ui.js';

const PATIENTS = [
  { mr: '100001', nama: 'ALPHA', tglReg: '2026-09-18 15:31:39' },
  { mr: '100002', nama: 'BRAVO', tglReg: '2026-09-18 08:15:00' },
  { mr: '100003', nama: 'CHARLIE', tglReg: '2026-09-17 23:59:59' },
  { mr: '100004', nama: 'DELTA', tglReg: '2026-09-18' }, // date-only
  { mr: '100005', nama: 'ECHO', tglReg: '2026-09-19 07:00:00' },
];

async function mrOrder(page: any): Promise<string[]> {
  return page
    .locator('table tbody tr')
    .evaluateAll((trs: Element[]) =>
      trs.map((tr) => tr.querySelector('td:nth-child(3)')?.textContent ?? ''),
    );
}

test('default sort is Tgl Reg desc (time-aware); header toggles asc', async ({ server, page }) => {
  const { base, dir } = server;
  const f = buildRegistryFile(dir, 'nusin', '19-09-26', PATIENTS);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.length === 5);
  await page.waitForSelector('table tbody tr');

  // Desc: ECHO (19th) > ALPHA (18th 15:31) > BRAVO (18th 08:15) > DELTA
  // (18th 00:00, date-only) > CHARLIE (17th).
  expect(await mrOrder(page)).toEqual(['100005', '100001', '100002', '100004', '100003']);

  // Toggle to asc via header (TanStack cycle: desc → unsorted → asc).
  await page.locator('th button', { hasText: 'Tgl Reg' }).click();
  await page.locator('th button', { hasText: 'Tgl Reg' }).click();
  expect(await mrOrder(page)).toEqual(['100003', '100004', '100002', '100001', '100005']);
});
