// Ports v1 test_lab.py / test_lab2.py / test_lab3.py / test_lab4.py /
// test_copylab_http.py / test_repro_lab_update.py:
// lab file parsing, abnormal/kritis flags, latest-wins replacement,
// section headers, filters, copy-to-clipboard.
import { test, expect } from '../helpers/fixture.js';
import { buildLabFile, buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { rowFor, uploadFiles, waitRows } from '../helpers/ui.js';

const MR = '000623';

test('lab upload: summary, sections, abnormal + kritis flags, latest-wins replacement, copy', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'LABPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));

  // Report 1: 2 tests, 1 abnormal (Hb 5.1 vs 12-16), sections.
  const lab1 = buildLabFile(dir, MR, [
    {
      jenis: 'Hematologi',
      tests: [
        { nama: 'Hb', hasil: '5.1', normal: '12 - 16', satuan: 'g/dL', tanggal: '2026-10-12' },
        { nama: 'WBC', hasil: '6.2', normal: '4 - 10', satuan: '/uL', tanggal: '2026-10-12' },
      ],
    },
  ]);
  await uploadFiles(page, [lab1], '#lab-input');
  await waitRows(base, 'active', (r) => r.find((x) => x.mr === MR)?.lab?.testCount === 2);
  let rows = await apiRows(base);
  let lab = rows.find((x: any) => x.mr === MR).lab;
  expect(lab.abnormal).toBe(1);
  expect(lab.kritis).toBe(0);

  // UI: summary line + expand → section header + abnormal value red.
  const row = rowFor(page, MR);
  await expect(row.locator('button', { hasText: '2 tests · 1 abnormal' })).toHaveCount(1);
  await row.locator('button', { hasText: '2 tests' }).click();
  await page.waitForSelector('text=Hasil Laboratorium');
  expect(await page.locator('td', { hasText: /^Jenis: Hematologi$/ }).count()).toBe(1);
  await expect(row.locator('td', { hasText: 'LK' })).toHaveCount(0);
  // Abnormal value renders in red (text-red-600 class). The expanded panel
  // is a separate <tr>, so scope to the page.
  await expect(page.locator('td.font-semibold.text-red-600', { hasText: '5.1' })).toHaveCount(1);

  // Copy visible tests (clipboard permission granted for headless).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('button', { hasText: '📋 Copy' }).click();
  await page.waitForSelector('div.fixed div', { timeout: 5000 });
  const toast = await page.locator('div.fixed div').last().innerText();
  expect(toast).toContain('Copied 2 test(s)');

  // Report 2 (latest wins): 1 kritis test ("dilaporkan" in keterangan).
  const lab2 = buildLabFile(dir, MR, [
    {
      jenis: 'Kimia',
      tests: [{ nama: 'Kreatinin', hasil: '15.4', normal: '0.6 - 1.3', satuan: 'mg/dL', keterangan: 'Dilaporkan', tanggal: '2026-10-13' }],
    },
  ]);
  await uploadFiles(page, [lab2], '#lab-input');
  await waitRows(base, 'active', (r) => r.find((x) => x.mr === MR)?.lab?.maxDate === '2026-10-13');
  rows = await apiRows(base);
  lab = rows.find((x: any) => x.mr === MR).lab;
  expect(lab.testCount).toBe(1);
  expect(lab.kritis).toBe(1);
  // Kritis badge on the cell; the still-open panel auto-refreshes to the
  // new report (LK marker) without re-clicking.
  await expect(row.locator('text=⚠ Lab Kritis')).toHaveCount(1);
  await page.getByText('LK', { exact: true }).waitFor();
});

test('lab filename without MR is skipped with a message', async ({ server, page }) => {
  const { base, dir } = server;
  const reg = buildRegistryFile(dir, 'nusin', '12-10-26', [
    { mr: MR, nama: 'LABPAT', tglReg: '2026-10-12 08:00:00' },
  ]);
  await page.goto(base, { waitUntil: 'load' });
  await uploadFiles(page, [reg]);
  await waitRows(base, 'active', (r) => r.some((x) => x.mr === MR));

  // Build a lab file, then rename it to a non-lab- prefix.
  const p = buildLabFile(dir, MR, [
    { jenis: 'Hematologi', tests: [{ nama: 'Hb', hasil: '14', normal: '12 - 16', tanggal: '2026-10-12' }] },
  ]);
  const bad = p.replace(`lab-${MR}.xlsx`, 'unknown-file.xlsx');
  await import('node:fs').then((fs) => fs.renameSync(p, bad));
  await uploadFiles(page, [bad], '#lab-input');
  await page.waitForSelector('div.fixed div', { timeout: 5000 });
  const toast = await page.locator('div.fixed div').last().innerText();
  expect(toast).toContain('no MR in name');
});
