// Ports v1 test_note.py (+ editable-fields coverage for ALL facilities —
// v2 matches v1's COLS_SHORT === COLS_FULL: diagnosis/operan/terapi/note
// are editable everywhere, not just Nusin).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { rowFor, waitRows, uploadFiles } from '../helpers/ui.js';

test('note + diagnosis/operan/terapi editable on a non-nusin facility and persist', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const f = buildRegistryFile(dir, 'sakura', '12-10-26', [
    { mr: '300001', nama: 'SAKUPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [f]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === '300001'));
  await page.locator('nav button', { hasText: 'Sakura' }).click();

  const row = rowFor(page, '300001');

  // Note (last editable cell before the actions column).
  const noteCell = row.locator('span.cursor-text').last();
  await noteCell.click();
  await row.locator('textarea').last().fill('NOTE P8');
  await row.locator('textarea').last().blur();
  await page.waitForTimeout(400);

  // Diagnosis (first editable cell).
  await row.locator('span.cursor-text').first().click();
  await row.locator('textarea').first().fill('DX P8');
  await row.locator('textarea').first().blur();
  await page.waitForTimeout(400);

  const rows = await apiRows(base);
  const r = rows.find((x: any) => x.mr === '300001');
  expect(r.pharmacistNote).toBe('NOTE P8');
  expect(r.diagnosis).toBe('DX P8');
});
