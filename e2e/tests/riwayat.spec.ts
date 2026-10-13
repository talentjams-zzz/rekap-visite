// Ports v1 test_riwayat.py + test_manual_riwayat.py:
// per-day riwayat snapshots; manually typed Diagnosis/Operan/Terapi are
// recorded into the CURRENT day's snapshot (v1 manual-riwayat regression).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiHistory, apiRows } from '../helpers/server.js';

const MR = '550001';

test('riwayat keeps one snapshot per day; manual diagnosis edit lands in current-day snapshot', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const p1 = { mr: MR, nama: 'RADIO', tglReg: '2026-09-10 09:00:00' };
  const f10 = buildRegistryFile(dir, 'nusin', '10-09-26', [p1]);
  const f11 = buildRegistryFile(dir, 'nusin', '11-09-26', [p1]);

  await page.goto(base, { waitUntil: 'load' });
  await page.locator('#file-input').setInputFiles([f10]);
  await page.waitForSelector('table tbody tr');

  // Badge: 0 past days initially.
  expect(await page.locator('table tbody button', { hasText: '▼' }).count()).toBe(0);

  // Edit diagnosis on the current day (in-place cell).
  await page.locator('table tbody tr').first().locator('span.cursor-text').first().click();
  const ta = page.locator('table tbody tr').first().locator('textarea').first();
  await ta.fill('TEST DX P8');
  await ta.blur();
  await page.waitForTimeout(400);

  // Upload the next day → previous day becomes a past riwayat entry.
  await page.locator('#file-input').setInputFiles([f11]);
  const rows = await apiRows(base);
  const row = rows.find((r: any) => r.mr === MR);
  expect(row.dayCount).toBe(2);

  // Badge shows 1 past day; expanding lists it with the edited diagnosis.
  const badge = page.locator('table tbody button', { hasText: 'Riwayat (1)' }).first();
  await badge.click();
  await page.waitForSelector('text=Riwayat (past days)');
  const histTable = page.locator('table table tbody tr').first();
  expect(await histTable.innerText()).toContain('TEST DX P8');

  // API agrees.
  const hist = await apiHistory(base, row.id);
  expect(hist.length).toBe(1);
  expect(hist[0].date).toBe('2026-09-10');
  expect(hist[0].diagnosis).toBe('TEST DX P8');
});
