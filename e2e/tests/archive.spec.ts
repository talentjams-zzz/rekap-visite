// Ports v1 test_auto_archive.py + test_repro_874240.py:
// facility latest-input drives auto archive/unarchive on every upload.
import { test, expect } from '../helpers/fixture.js';
import { buildRegistryFile } from '../helpers/xlsx.js';
import { apiRows } from '../helpers/server.js';
import { waitRows, uploadFiles } from '../helpers/ui.js';

const A = { mr: '600001', nama: 'ALPHA', tglReg: '2026-08-25 08:00:00' };
const B = { mr: '600002', nama: 'BRAVO', tglReg: '2026-08-25 09:00:00' };

test('new day archives absent patients and unarchives returning ones', async ({
  server,
  page,
}) => {
  const { base, dir } = server;
  const f25 = buildRegistryFile(dir, 'nusin', '25-08-26', [A, B]);
  const f26 = buildRegistryFile(dir, 'nusin', '26-08-26', [A]); // B absent
  const f27 = buildRegistryFile(dir, 'nusin', '27-08-26', [B]); // A absent, B back

  await page.goto(base, { waitUntil: 'load' });

  await uploadFiles(page, [f25]);
  await waitRows(base, 'active', (r) => r.length === 2);
  expect((await apiRows(base, 'archived')).length).toBe(0);

  // Day 26: B absent → auto-archived; A stays.
  await uploadFiles(page, [f26]);
  await waitRows(base, 'active', (r) => r.length === 1 && r[0].mr === A.mr);
  let arch = await apiRows(base, 'archived');
  expect(arch.map((r: any) => r.mr)).toEqual([B.mr]);

  // Day 27: B returns → unarchived; A now absent → archived.
  await uploadFiles(page, [f27]);
  await waitRows(base, 'active', (r) => r.length === 1 && r[0].mr === B.mr);
  arch = await apiRows(base, 'archived');
  expect(arch.map((r: any) => r.mr)).toEqual([A.mr]);
  expect(arch[0].archivedAt).toBeTruthy();
});
