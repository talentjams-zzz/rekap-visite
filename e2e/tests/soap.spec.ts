// SOAP column (v2 feature): free text, resets to blank when the next day's
// file arrives; the previous day's SOAP moves to Riwayat (per-day snapshot).
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { rowFor, uploadFiles, waitRows } from '../helpers/ui.js';

const MR = '410001';
const SOAP_TEXT = 'S: stable, O: pain 3/10, A: improving, P: continue';

test('SOAP: free text, cleared on the next day, previous day moves to Riwayat', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  await page.goto(base, { waitUntil: 'load' });
  const f26 = buildRegistryFile(dir, 'nusin', '26-08-26', [
    { mr: MR, nama: 'SOAP PAT', tglReg: '2026-08-26 08:00:00' },
  ]);
  await uploadFiles(page, [f26]);
  await waitRows(base, 'active', (r) => r.length === 1);

  // SOAP is the last editable cell (after Note).
  const row = rowFor(page, MR);
  await row.locator('span.cursor-text').last().click();
  await row.locator('textarea').last().fill(SOAP_TEXT);
  await row.locator('textarea').last().blur();
  await page.waitForTimeout(400);

  // Persists server-side.
  expect((await apiRows(base))[0].soap).toBe(SOAP_TEXT);

  // Next day's file → SOAP cleared on the live row…
  const f27 = buildRegistryFile(dir, 'nusin', '27-08-26', [
    { mr: MR, nama: 'SOAP PAT', tglReg: '2026-08-26 08:00:00' },
  ]);
  await uploadFiles(page, [f27]);
  await waitRows(base, 'active', (r) => r[0].dateAdded === '2026-08-27');
  expect((await apiRows(base))[0].soap ?? '').toBe(''); // blank (NULL in DB)

  // …and the previous day's SOAP is in Riwayat.
  await page.locator('table tbody button', { hasText: 'Riwayat (1)' }).first().click();
  await page.waitForSelector('text=Riwayat (past days)');
  const histRow = page.locator('table table tbody tr').first();
  expect(await histRow.innerText()).toContain(SOAP_TEXT);
});
